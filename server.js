/**
 * Serveur relais "Mes Ruches" — v2 avec PostgreSQL persistant
 * ----------------------------------------------------------
 * - Collecte BeeZbee toutes les heures
 * - Stocke l'historique en base PostgreSQL (persistent sur Render)
 * - Envoie des notifications push sur iPhone quand le poids varie
 * - Expose une API pour la PWA
 */

const express = require('express');
const fetch   = require('node-fetch');
const cron    = require('node-cron');
const webpush = require('web-push');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ─── CORS : autoriser la PWA à appeler l'API depuis l'iPhone ──────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  next();
});

// ─── BASE DE DONNÉES ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS releves (
      id        SERIAL PRIMARY KEY,
      ruche_id  TEXT NOT NULL,
      ruche_nom TEXT NOT NULL,
      date_mesure TIMESTAMP NOT NULL,
      poids     REAL,
      temperature REAL,
      hygrometrie REAL,
      batterie  REAL
    );
    CREATE INDEX IF NOT EXISTS idx_releves_ruche_date
      ON releves(ruche_id, date_mesure DESC);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id       SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      data     JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      cle   TEXT PRIMARY KEY,
      valeur TEXT NOT NULL
    );

    INSERT INTO config(cle, valeur) VALUES ('seuil_kg', '1.0')
      ON CONFLICT (cle) DO NOTHING;
  `);
  console.log('Base de données initialisée.');
}

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const RUCHES = [
  {
    id:  '7B464',
    nom: 'Château Massilan',
    csvUrl: 'https://beezbee.ddns.net/beezbee-curve/beezbee-disp-7B464/importcsv.php',
    indexUrl: 'https://beezbee.ddns.net/beezbee-curve/beezbee-disp-7B464/index.php'
  },
  {
    id:  '7B462',
    nom: 'Lac Li Piboulos',
    csvUrl: 'https://beezbee.ddns.net/beezbee-curve/beezbee-disp-7B462/importcsv.php',
    indexUrl: 'https://beezbee.ddns.net/beezbee-curve/beezbee-disp-7B462/index.php'
  },
  {
    id:  '7B45C',
    nom: 'La Comtesse',
    csvUrl: 'https://beezbee.ddns.net/beezbee-curve/beezbee-disp-7B45C/importcsv.php',
    indexUrl: 'https://beezbee.ddns.net/beezbee-curve/beezbee-disp-7B45C/index.php'
  }
];

// Récupérer la batterie depuis la page index BeeZbee
async function getBatterie(indexUrl) {
  try {
    const html = await (await fetch(indexUrl, { timeout: 10000 })).text();
    // La page contient "Batterie XX   + XX %"
    const match = html.match(/Batterie\s+(\d+)/i);
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

// ─── NOTIFICATIONS PUSH (VAPID) ───────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:toi@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function envoyerNotification(titre, corps) {
  const { rows } = await pool.query('SELECT data FROM subscriptions');
  const payload  = JSON.stringify({ title: titre, body: corps });

  for (const row of rows) {
    try {
      await webpush.sendNotification(row.data, payload);
    } catch (err) {
      if (err.statusCode === 410) {
        // Abonnement expiré → on le supprime
        await pool.query('DELETE FROM subscriptions WHERE data @> $1',
          [JSON.stringify({ endpoint: row.data.endpoint })]);
      } else {
        console.error('Erreur notification :', err.message);
      }
    }
  }
}

// ─── PARSING CSV BEEZBEE ──────────────────────────────────────────────────────
function parseCsv(texte) {
  return texte.trim().split('\n').slice(1).map(ligne => {
    const cols = ligne.split(';');
    return {
      date:        cols[0]?.trim(),
      poids:       parseFloat(cols[1]),
      temperature: parseFloat(cols[2]),
      hygrometrie: parseFloat(cols[3]),
      batterie:    parseFloat(cols[4]) || null
    };
  }).filter(r => r.date && !isNaN(r.poids));
}

// ─── COLLECTE HORAIRE ────────────────────────────────────────────────────────
async function collecterToutesLesRuches() {
  console.log(`[${new Date().toISOString()}] Collecte BeeZbee...`);

  // Lire le seuil actuel
  const { rows: cfgRows } = await pool.query(
    "SELECT valeur FROM config WHERE cle = 'seuil_kg'"
  );
  const seuilKg = parseFloat(cfgRows[0]?.valeur || '1.0');

  for (const ruche of RUCHES) {
    try {
      const reponse = await fetch(ruche.csvUrl, { timeout: 15000 });
      const texte   = await reponse.text();
      const releves = parseCsv(texte);
      if (releves.length === 0) continue;

      // Récupérer la batterie depuis la page index
      const batterie = await getBatterie(ruche.indexUrl);

      // Dernier relevé connu en base
      const { rows: derniers } = await pool.query(
        `SELECT poids, date_mesure FROM releves
         WHERE ruche_id = $1 ORDER BY date_mesure DESC LIMIT 1`,
        [ruche.id]
      );
      const dernierConnu = derniers[0] || null;

      // Insérer seulement les points nouveaux (depuis la dernière date connue)
      const depuis = dernierConnu
        ? new Date(dernierConnu.date_mesure)
        : new Date(0);

      let nbInseres = 0;
      for (const r of releves) {
        const dateReleve = new Date(r.date);
        if (dateReleve > depuis) {
          await pool.query(
            `INSERT INTO releves(ruche_id, ruche_nom, date_mesure, poids, temperature, hygrometrie, batterie)
             VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [ruche.id, ruche.nom, r.date, r.poids, r.temperature, r.hygrometrie, r.batterie ?? batterie]
          );
          nbInseres++;
        }
      }

      if (nbInseres > 0) console.log(`  ${ruche.nom} : +${nbInseres} nouveaux points`);

      // Détection de variation sur le tout dernier point
      const dernierReleve = releves[releves.length - 1];
      if (dernierConnu && !isNaN(dernierConnu.poids)) {
        const variation = dernierReleve.poids - dernierConnu.poids;
        if (Math.abs(variation) >= seuilKg) {
          const sens   = variation > 0 ? '+' : '';
          const emoji  = variation > 0 ? '📈' : '📉';
          await envoyerNotification(
            `${emoji} ${ruche.nom}`,
            `Variation de poids : ${sens}${variation.toFixed(1)} kg → ${dernierReleve.poids.toFixed(1)} kg`
          );
        }
      }

    } catch (err) {
      console.error(`Erreur ${ruche.nom} :`, err.message);
    }
  }

  console.log('Collecte terminée.');
}

// Toutes les heures
cron.schedule('5 * * * *', collecterToutesLesRuches);

// ─── API ──────────────────────────────────────────────────────────────────────

// Données courantes de toutes les ruches (dernier relevé + dernière batterie non nulle)
app.get('/api/ruches', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (r.ruche_id)
        r.ruche_id, r.ruche_nom, r.date_mesure, r.poids, r.temperature, r.hygrometrie,
        COALESCE(r.batterie, b.batterie) AS batterie
      FROM releves r
      LEFT JOIN LATERAL (
        SELECT batterie FROM releves
        WHERE ruche_id = r.ruche_id AND batterie IS NOT NULL
        ORDER BY date_mesure DESC LIMIT 1
      ) b ON true
      ORDER BY r.ruche_id, r.date_mesure DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// Historique d'une ruche (avec plage optionnelle : ?jours=7, ?jours=30, ?jours=365)
app.get('/api/ruches/:id/historique', async (req, res) => {
  try {
    const jours = parseInt(req.query.jours) || 9999;
    const { rows } = await pool.query(`
      SELECT date_mesure, poids, temperature, hygrometrie, batterie
      FROM releves
      WHERE ruche_id = $1
        AND date_mesure >= NOW() - ($2 || ' days')::INTERVAL
      ORDER BY date_mesure ASC
    `, [req.params.id, jours]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// Clé VAPID publique (nécessaire pour s'abonner aux notifs depuis la PWA)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// Enregistrer un abonnement depuis l'iPhone
app.post('/api/subscribe', async (req, res) => {
  try {
    const sub = req.body;
    await pool.query(
      `INSERT INTO subscriptions(endpoint, data) VALUES($1, $2)
       ON CONFLICT (endpoint) DO UPDATE SET data = $2`,
      [sub.endpoint, sub]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// Supprimer un abonnement (désactiver les notifs)
app.delete('/api/subscribe', async (req, res) => {
  try {
    await pool.query('DELETE FROM subscriptions WHERE endpoint = $1', [req.body.endpoint]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// Lire / modifier le seuil de notification (en kg)
app.get('/api/config/seuil', async (req, res) => {
  const { rows } = await pool.query("SELECT valeur FROM config WHERE cle='seuil_kg'");
  res.json({ seuil_kg: parseFloat(rows[0]?.valeur || '1.0') });
});

app.post('/api/config/seuil', async (req, res) => {
  const seuil = parseFloat(req.body.seuil_kg);
  if (isNaN(seuil) || seuil <= 0) return res.status(400).json({ erreur: 'Seuil invalide' });
  await pool.query(
    "INSERT INTO config(cle,valeur) VALUES('seuil_kg',$1) ON CONFLICT(cle) DO UPDATE SET valeur=$1",
    [seuil.toString()]
  );
  res.json({ ok: true, seuil_kg: seuil });
});

// Forcer une collecte immédiate (pour tests)
app.post('/api/collecter-maintenant', async (req, res) => {
  collecterToutesLesRuches();
  res.json({ ok: true, message: 'Collecte lancée en arrière-plan' });
});

// Batterie en temps réel pour toutes les ruches
app.get('/api/batteries', async (req, res) => {
  try {
    const results = await Promise.all(RUCHES.map(async ruche => {
      const batt = await getBatterie(ruche.indexUrl);
      // Mettre à jour la dernière ligne en base si on a la valeur
      if (batt !== null) {
        await pool.query(
          `UPDATE releves SET batterie = $1
           WHERE id = (SELECT id FROM releves WHERE ruche_id = $2 ORDER BY date_mesure DESC LIMIT 1)`,
          [batt, ruche.id]
        );
      }
      return { ruche_id: ruche.id, ruche_nom: ruche.nom, batterie: batt };
    }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

// Debug batterie - voir ce que BeeZbee renvoie
app.get('/api/debug-batt', async (req, res) => {
  try {
    const ruche = RUCHES[1]; // Lac Li Piboulos
    // Test 1: CSV
    const csv = await (await fetch(ruche.csvUrl, { timeout: 10000 })).text();
    const lignes = csv.trim().split('\n');
    const header = lignes[0];
    const derniereLigne = lignes[lignes.length - 1];
    const cols = derniereLigne.split(';');

    // Test 2: Index page
    const html = await (await fetch(ruche.indexUrl, { timeout: 10000 })).text();
    const battMatch = html.match(/Batterie[\s\S]{0,30}?(\d+)/i);

    // Test 3: Base de données
    const { rows } = await pool.query(
      'SELECT batterie, date_mesure FROM releves WHERE ruche_id=$1 AND batterie IS NOT NULL ORDER BY date_mesure DESC LIMIT 3',
      [ruche.id]
    );

    res.json({
      csv: {
        header,
        derniereLigne,
        nbColonnes: cols.length,
        col4: cols[4] || 'ABSENT',
        parsedBatterie: parseFloat(cols[4]) || null
      },
      indexPage: {
        battMatch: battMatch ? battMatch[0] : 'PAS DE MATCH',
        valeur: battMatch ? battMatch[1] : null,
        extraitHTML: html.substring(0, 300)
      },
      baseDonnees: rows
    });
  } catch (err) {
    res.status(500).json({ erreur: err.message, stack: err.stack });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── PROXY IA (Claude API) ────────────────────────────────────────────────────
// La PWA ne peut pas appeler directement l'API Anthropic (CORS).
// Le serveur fait le relais de façon sécurisée.

async function appelClaude(prompt, imageData = null) {
  const content = imageData
    ? [
        { type: 'image', source: { type: 'base64', media_type: imageData.type, data: imageData.data } },
        { type: 'text', text: prompt }
      ]
    : prompt;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || '';
}

// Analyse courbe de poids
app.post('/api/ia/analyser-poids', async (req, res) => {
  try {
    const { rucheNom, donnees, alertes } = req.body;
    const prompt = `Tu es un expert apiculteur français. Analyse la courbe de poids de la ruche "${rucheNom}" sur les 30 derniers jours.\n\nDonnées (date, poids, température intérieure):\n${donnees}\n\nAlertes détectées: ${alertes || 'aucune'}\n\nDonne une analyse structurée avec:\n1. État général de la colonie\n2. Points remarquables (pics, baisses, tendances)\n3. Interprétation apicole\n4. Recommandations concrètes\n\nSois précis et pratique. Réponds en français.`;
    const result = await appelClaude(prompt);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Analyse photo de cadre
app.post('/api/ia/analyser-photo', async (req, res) => {
  try {
    const { imageData, imageType } = req.body;
    const prompt = `Tu es un expert apiculteur. Analyse ce cadre de ruche en détail:\n1. État général du cadre\n2. Couvain (présence, qualité, operculation)\n3. Reine visible ou indices de présence\n4. Réserves (miel, pollen)\n5. Signes de maladies ou problèmes (loque, varroa, nosema…)\n6. Recommandations immédiates\n\nSois précis et pratique. Réponds en français.`;
    const result = await appelClaude(prompt, { type: imageType, data: imageData });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Prévision des récoltes
app.post('/api/ia/prevision-recoltes', async (req, res) => {
  try {
    const { donnees, totalRecolte, dateActuelle } = req.body;
    const prompt = `Tu es un expert apiculteur. Base-toi sur ces données de ruches pour faire une prévision de récolte:\n\n${donnees}\n\nTotal déjà récolté cette année: ${totalRecolte} kg\nDate actuelle: ${dateActuelle}\n\nDonne:\n1. Estimation de récolte par ruche pour les 2-3 prochains mois\n2. Total estimé\n3. Conditions à surveiller\n4. Moment optimal pour la récolte\n\nSois précis et pratique. Réponds en français.`;
    const result = await appelClaude(prompt);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

initDB()
  .then(() => collecterToutesLesRuches())
  .then(() => {
    app.listen(PORT, '0.0.0.0', () =>
      console.log(`Serveur démarré sur le port ${PORT}`)
    );
  })
  .catch(err => {
    console.error('Erreur démarrage :', err);
    process.exit(1);
  });
