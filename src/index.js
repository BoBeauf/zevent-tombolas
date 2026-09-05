/* ZEvent Tombolas — scanner et API, en lecture seule.
   Aucune écriture vers l'extérieur : uniquement des GET sur des endpoints publics. */

import { DurableObject } from 'cloudflare:workers'
import SEED from './seed.json'

const EMS = 'https://api.evenmorestats.fr'
const ZAPI = 'https://api.zevent.fr'          // backend du module officiel (app.zevent.fr)
const UA = 'zevent-tombolas/1.0 (usage personnel, lecture seule)'

/* Budget de requêtes. L'API des organisateurs rate-limite fort : mesuré à 276 réponses
   429 sur 339 requêtes en rafale à concurrence 4. À ~2,5 req/s en série, zéro 429 sur
   38 balayages complets. On garde cette cadence : 25 requêtes toutes les 10 secondes.

   Le plan gratuit Workers plafonne à 50 sous-requêtes par invocation, ce qui rendrait un
   Cron Trigger (1 minute de granularité minimale) incapable de dépasser 0,8 req/s. D'où
   l'alarme de Durable Object, qui se replanifie librement en dessous de la minute. */
const TICK_MS = 10_000
const BUDGET = 25

/* Types d'événements acceptés par /api/hit. Liste blanche stricte : l'endpoint est
   public, sans elle n'importe qui pourrait créer des compteurs arbitraires. */
const EVENTS = ['notif_on', 'notif_off', 'notif_granted', 'don', 'twitch', 'pseudo', 'share']
const KINDS = new Set(['view', ...EVENTS])

const now = () => Math.floor(Date.now() / 1000)
const str = v => (v == null ? null : typeof v === 'string' ? v : String(v))
// ATTENTION : contrairement à toutes les autres API du ZEvent, celle-ci renvoie des
// EUROS en flottant, pas des centimes. Vérifié sur des tombolas dont le total égalait
// exactement la cagnotte du streamer.
const eurToCents = v => Math.round((Number(v) || 0) * 100)
const mapAmounts = arr => (Array.isArray(arr) ? arr : [])
  .map(x => ({ name: str(x.name ?? x.donor), cents: eurToCents(x.amount) }))
  .filter(x => x.name != null || x.cents)

export class Scanner extends DurableObject {
  constructor (ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS streamers(
        twitch_id TEXT PRIMARY KEY, name TEXT, login TEXT, avatar TEXT,
        live INTEGER DEFAULT 0, cents INTEGER DEFAULT 0, viewers INTEGER DEFAULT 0,
        ever INTEGER DEFAULT 0,          -- a déjà lancé une tombola : forte priorité
        last_scan INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tombolas(
        id TEXT PRIMARY KEY, twitch_id TEXT, streamer TEXT, login TEXT, avatar TEXT,
        name TEXT, mode TEXT, high_value INTEGER, end_ts INTEGER,
        drawn INTEGER, n_winners INTEGER, winners TEXT,
        cents INTEGER, n_dons INTEGER, top TEXT,
        first_seen INTEGER, last_seen INTEGER);
      CREATE INDEX IF NOT EXISTS i_tb_drawn ON tombolas(drawn, end_ts);
      /* Fréquentation. Le tableau de bord Cloudflare compte les requêtes, ce qui mélange
         chargements de page et sondages d'API — on compte donc les visites nous-mêmes.
         « vid » est un identifiant aléatoire tiré par le navigateur, sans lien avec l'IP :
         il permet de distinguer deux visites du même visiteur, rien d'autre. */
      CREATE TABLE IF NOT EXISTS hits(day TEXT, kind TEXT, n INTEGER, PRIMARY KEY(day, kind));
      CREATE TABLE IF NOT EXISTS visitors(day TEXT, vid TEXT, PRIMARY KEY(day, vid));
      -- personnes distinctes par type d'événement (alerte activée, clic don, clic Twitch…)
      CREATE TABLE IF NOT EXISTS ev(day TEXT, kind TEXT, vid TEXT, PRIMARY KEY(day, kind, vid));
    `)
    ctx.blockConcurrencyWhile(async () => { await this.arm() })
  }

  meta (k, d = null) {
    const r = this.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray()[0]
    return r ? r.v : d
  }

  setMeta (k, v) {
    this.sql.exec('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v))
  }

  // Réarme l'alarme si elle a disparu (premier démarrage, redéploiement, incident).
  async arm () {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 1000)
  }

  async fetch (req) {
    const u = new URL(req.url)
    await this.arm()
    if (u.pathname === '/scan') return new Response('ok')
    if (u.pathname === '/hit') { this.hit(u.searchParams.get('v'), u.searchParams.get('k') || 'view'); return new Response('ok') }
    if (u.pathname === '/stats') return Response.json(this.stats())
    return Response.json(this.payload())
  }

  hit (vid, kind) {
    const day = new Date().toISOString().slice(0, 10)
    this.sql.exec('INSERT INTO hits(day,kind,n) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET n=n+1', day, kind)
    const v = vid ? String(vid).slice(0, 24) : null
    if (v && kind === 'view') this.sql.exec('INSERT OR IGNORE INTO visitors(day,vid) VALUES(?,?)', day, v)
    else if (v) this.sql.exec('INSERT OR IGNORE INTO ev(day,kind,vid) VALUES(?,?,?)', day, kind, v)
    // 30 jours d'historique suffisent, et le stockage reste minuscule
    const cut = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    this.sql.exec('DELETE FROM hits WHERE day < ?', cut)
    this.sql.exec('DELETE FROM visitors WHERE day < ?', cut)
    this.sql.exec('DELETE FROM ev WHERE day < ?', cut)
  }

  stats () {
    const days = this.sql.exec(
      `SELECT h.day,
              COALESCE(SUM(CASE WHEN h.kind='view' THEN h.n END),0) AS views,
              (SELECT COUNT(*) FROM visitors v WHERE v.day = h.day) AS visitors,
              COALESCE(SUM(CASE WHEN h.kind='api' THEN h.n END),0) AS api
       FROM hits h GROUP BY h.day ORDER BY h.day DESC LIMIT 14`).toArray()
    const today = new Date().toISOString().slice(0, 10)
    const t = days.find(d => d.day === today) || { views: 0, visitors: 0, api: 0 }
    // Usage : clics cumulés et personnes distinctes, aujourd'hui et depuis le début
    const ev = {}
    for (const k of EVENTS) {
      const all = this.sql.exec('SELECT COALESCE(SUM(n),0) n FROM hits WHERE kind=?', k).toArray()[0]?.n ?? 0
      const day = this.sql.exec('SELECT COALESCE(SUM(n),0) n FROM hits WHERE kind=? AND day=?', k, today).toArray()[0]?.n ?? 0
      const pAll = this.sql.exec('SELECT COUNT(DISTINCT vid) n FROM ev WHERE kind=?', k).toArray()[0]?.n ?? 0
      const pDay = this.sql.exec('SELECT COUNT(DISTINCT vid) n FROM ev WHERE kind=? AND day=?', k, today).toArray()[0]?.n ?? 0
      ev[k] = { clicks: all, clicksToday: day, people: pAll, peopleToday: pDay }
    }
    const totalVisitors = this.sql.exec('SELECT COUNT(DISTINCT vid) n FROM visitors').toArray()[0]?.n ?? 0
    return {
      today, days: days.reverse(), events: ev, totalVisitors,
      // Le quota qui compte : 100 000 invocations de Worker par jour sur le plan gratuit.
      quota: { limit: 100_000, usedToday: t.views + t.api, note: 'estimation locale ; le chiffre autoritaire est dans le tableau de bord Cloudflare' },
      scan: { wakeupsPerDay: Math.round(86400 / (TICK_MS / 1000)), subrequestsPerDay: Math.round(86400 / (TICK_MS / 1000)) * BUDGET },
      since: this.sql.exec('SELECT MIN(day) d FROM hits').toArray()[0]?.d ?? null,
    }
  }

  async get (url, timeoutMs = 12_000) {
    const sep = url.includes('?') ? '&' : '?'
    const r = await fetch(url + sep + '_=' + Date.now(), {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (r.status === 429) { const e = new Error('429'); e.rateLimited = true; throw e }
    if (r.status === 404) { const e = new Error('404'); e.notFound = true; throw e }
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return r.json()
  }

  /* L'édition courante est découverte, pas codée en dur : l'outil survit à 2027 sans
     redéploiement. On prend celle dont le calendrier contient l'instant présent, sinon
     la plus récente. */
  async refreshEvent () {
    const list = await this.get(`${EMS}/events`)
    const z = list.filter(e => /^ZEvent/.test(e.name))
      .sort((a, b) => b.schedule.start.localeCompare(a.schedule.start))
    if (!z.length) return null
    const t = Date.now()
    const cur = z.find(e => {
      const s = e.schedule_raising || e.schedule
      return Date.parse(s.start) <= t && t <= Date.parse(s.end)
    })
    const ev = cur || z[0]
    const s = ev.schedule_raising || ev.schedule
    this.setMeta('event_id', ev.id)
    this.setMeta('event_name', ev.name)
    this.setMeta('event_start', Math.floor(Date.parse(s.start) / 1000))
    this.setMeta('event_end', Math.floor(Date.parse(s.end) / 1000))
    this.setMeta('event_at', now())
    return ev.id
  }

  // Liste des participants : nom, avatar, login et identifiant Twitch, statut live.
  async refreshStreamers () {
    let id = this.meta('event_id')
    if (!id || now() - Number(this.meta('event_at', 0)) > 3600) id = (await this.refreshEvent()) || id
    if (!id) return
    const list = await this.get(`${EMS}/events/${id}/participations`, 20_000)
    if (!Array.isArray(list)) return
    const t = now()
    for (const p of list) {
      const s = p.streamers?.[0] || {}
      const tw = s.socials?.twitch
      if (!tw?.id) continue
      const viewers = (s.streaming_states || []).reduce((a, x) => a + (x.viewers || 0), 0)
      this.sql.exec(
        `INSERT INTO streamers(twitch_id,name,login,avatar,live,cents,viewers)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(twitch_id) DO UPDATE SET name=excluded.name, login=excluded.login,
           avatar=excluded.avatar, live=excluded.live, cents=excluded.cents, viewers=excluded.viewers`,
        String(tw.id), str(p.name), str(tw.login), str(p.profile_url),
        p.live ? 1 : 0, p.amount_raised ?? 0, viewers)
    }
    this.setMeta('streamers_at', t)
    this.setMeta('streamers_n', list.length)
  }

  saveTombola (t, ctx) {
    if (!t?.id) return null
    const ts = now()
    const id = String(t.id)
    const prev = this.sql.exec('SELECT id, drawn FROM tombolas WHERE id=?', id).toArray()[0]
    this.sql.exec(
      `INSERT INTO tombolas(id,twitch_id,streamer,login,avatar,name,mode,high_value,end_ts,
         drawn,n_winners,winners,cents,n_dons,top,first_seen,last_seen)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, mode=excluded.mode,
         high_value=excluded.high_value, end_ts=excluded.end_ts, drawn=excluded.drawn,
         n_winners=excluded.n_winners, winners=excluded.winners, cents=excluded.cents,
         n_dons=excluded.n_dons, top=excluded.top, last_seen=excluded.last_seen,
         streamer=COALESCE(excluded.streamer, tombolas.streamer),
         login=COALESCE(excluded.login, tombolas.login),
         avatar=COALESCE(excluded.avatar, tombolas.avatar)`,
      id, ctx.twitchId ?? null, ctx.name ?? null, ctx.login ?? null, ctx.avatar ?? null,
      str(t.name), str(t.tombolaMode), t.highValueLot ? 1 : 0,
      t.end ? Math.floor(Date.parse(t.end) / 1000) : null,
      t.drawn ? 1 : 0, t.numberOfWinners ?? null,
      JSON.stringify(mapAmounts(t.winners)), eurToCents(t.amount), t.number ?? null,
      JSON.stringify(mapAmounts(t.top)), ts, ts)
    if (ctx.twitchId) this.sql.exec('UPDATE streamers SET ever=1 WHERE twitch_id=?', ctx.twitchId)
    return { id, isNew: !prev, justDrawn: prev && !prev.drawn && t.drawn }
  }

  /* File d'attente à quatre niveaux, dans la limite du budget de requêtes :
       A — tombolas non tirées, relues par identifiant  → à chaque tick (10 s)
       B — streamers en live ayant déjà lancé une tombola → tour complet en ~1 min
       C — streamers en live                             → tour complet en ~2 min
       D — tout le monde                                 → tour complet en ~5 min
     Mesuré : 31 des 215 streamers en live ont déjà lancé une tombola. Ce préalable
     concentre le budget là où une nouvelle tombola a réellement des chances d'apparaître. */
  targets (budget) {
    const out = []
    const seen = new Set()
    const push = rows => {
      for (const r of rows) {
        if (out.length >= budget) return
        const k = r.byId || r.twitch_id
        if (seen.has(k)) continue
        seen.add(k); out.push(r)
      }
    }
    const t = now()
    // A : les tombolas ouvertes, y compris celles dont l'heure de fin vient de passer
    // (le tirage arrive quelques instants après) — mais pas les reliquats jamais clôturés.
    /* On relit le streamer depuis la table `streamers` plutôt que depuis la ligne de
       tombola : une tombola relue par identifiant n'a pas forcément son attribution
       (c'est le cas des lignes amorcées ci-dessous, et de celles vues avant que la
       liste des participants soit chargée). ORDER BY ... DESC place les end_ts NULL
       en dernier, donc les tombolas réellement en cours restent prioritaires. */
    push(this.sql.exec(
      `SELECT t.id AS byId, t.twitch_id, s.name, s.login, s.avatar
       FROM tombolas t LEFT JOIN streamers s ON s.twitch_id = t.twitch_id
       WHERE t.drawn=0 AND (t.end_ts IS NULL OR t.end_ts < ?)
       ORDER BY t.end_ts DESC LIMIT 12`,
      t + 6 * 3600).toArray())
    push(this.sql.exec(
      `SELECT twitch_id, name, login, avatar FROM streamers
       WHERE live=1 AND ever=1 ORDER BY last_scan LIMIT ?`, Math.ceil(budget * 0.35)).toArray())
    /* On garde 3 places pour la file D. Sans cette réserve, A+B+C consomment tout le
       budget dès qu'il y a une vingtaine de streamers en live, et les hors-ligne ne sont
       jamais balayés — or un streamer peut laisser une tombola tourner après avoir coupé. */
    const reserve = 3
    push(this.sql.exec(
      `SELECT twitch_id, name, login, avatar FROM streamers
       WHERE live=1 ORDER BY last_scan LIMIT ?`, Math.max(0, budget - out.length - reserve)).toArray())
    push(this.sql.exec(
      'SELECT twitch_id, name, login, avatar FROM streamers ORDER BY last_scan LIMIT ?', budget).toArray())
    return out
  }

  /* Amorçage. `/tombola/latest/{twitchId}` ne renvoie que la DERNIÈRE tombola d'un
     streamer : un scanner démarré en cours d'event ne peut donc jamais retrouver les
     précédentes — mesuré, 22 des 46 streamers concernés en avaient lancé plusieurs.
     `/tombola/{id}` fonctionne en revanche pour n'importe quel identifiant connu.

     On insère donc des lignes vides ne contenant qu'un identifiant et le streamer à qui
     l'attribuer. Le scan normal (file A) les remplit ensuite en interrogeant l'API
     officielle : aucune donnée n'est recopiée ici, seulement des identifiants. */
  seed () {
    if (this.meta('seeded') === SEED.eventId) return 0
    if (this.meta('event_id') !== SEED.eventId) return 0    // autre édition : rien à amorcer
    let n = 0
    for (const [id, twitchId] of SEED.tombolas) {
      const r = this.sql.exec(
        `INSERT INTO tombolas(id,twitch_id,drawn,cents,n_dons,winners,top,first_seen,last_seen)
         VALUES(?,?,0,0,0,'[]','[]',?,0) ON CONFLICT(id) DO NOTHING`, id, String(twitchId), now())
      n += r.rowsWritten ? 1 : 0
    }
    this.setMeta('seeded', SEED.eventId)
    this.setMeta('seeded_n', n)
    return n
  }

  async alarm () {
    const t0 = Date.now()
    let used = 0, hits = 0, rate = false
    const events = []
    try {
      // La liste des participants coûte une requête ; on la rafraîchit toutes les 3 min.
      if (now() - Number(this.meta('streamers_at', 0)) > 180) {
        try { await this.refreshStreamers(); used++ } catch { /* on réessaiera */ }
      }
      this.seed()
      const budget = Math.max(0, BUDGET - used)
      for (const it of this.targets(budget)) {
        if (rate) break
        const url = it.byId ? `${ZAPI}/tombola/${it.byId}` : `${ZAPI}/tombola/latest/${it.twitch_id}`
        used++
        try {
          const d = await this.get(url)
          if (it.twitch_id) this.sql.exec('UPDATE streamers SET last_scan=? WHERE twitch_id=?', now(), it.twitch_id)
          if (!d?.tombola) {
            // réponse valide mais sans tombola : l'identifiant n'existe plus, on le retire
            if (it.byId) this.sql.exec('DELETE FROM tombolas WHERE id=? AND last_seen=0', it.byId)
            continue
          }
          const r = this.saveTombola(d.tombola, {
            twitchId: it.twitch_id ?? null, name: it.name, login: it.login, avatar: it.avatar,
          })
          if (r) { hits++; if (r.isNew && !d.tombola.drawn) events.push(r.id) }
        } catch (e) {
          if (e.rateLimited) { rate = true; break }
          // 404 sur un identifiant : la tombola a été supprimée du module officiel.
          // On retire le repère, sinon il occupe une place dans la file A indéfiniment.
          if (e.notFound && it.byId) this.sql.exec('DELETE FROM tombolas WHERE id=? AND last_seen=0', it.byId)
          if (it.twitch_id) this.sql.exec('UPDATE streamers SET last_scan=? WHERE twitch_id=?', now(), it.twitch_id)
        }
      }
      this.setMeta('scan_at', now())
      this.setMeta('scan_used', used)
      this.setMeta('scan_ms', Date.now() - t0)
      if (rate) this.setMeta('rate_limited_at', now())
      if (events.length) this.setMeta('last_new', JSON.stringify({ at: now(), ids: events }))
    } finally {
      // Après un 429, on laisse retomber la pression avant de reprendre.
      await this.ctx.storage.setAlarm(Date.now() + (rate ? TICK_MS * 6 : TICK_MS))
    }
  }

  payload () {
    const parse = j => { try { return JSON.parse(j || '[]') } catch { return [] } }
    const rows = this.sql.exec('SELECT * FROM tombolas ORDER BY drawn, end_ts DESC').toArray()
    const t = now()
    const map = r => ({
      id: r.id, streamer: r.streamer, login: r.login, avatar: r.avatar,
      name: r.name, mode: r.mode, highValue: !!r.high_value, endTs: r.end_ts,
      drawn: !!r.drawn, nWinners: r.n_winners, winners: parse(r.winners),
      cents: r.cents, nDons: r.n_dons, top: parse(r.top),
      firstSeen: r.first_seen, age: t - (r.last_seen || 0),
    })
    const raw = rows.map(map)
    // Une tombola d'essai se reconnaît objectivement : zéro euro ET zéro participation.
    const real = raw.filter(x => x.cents || x.nDons)
    /* Une tombola non tirée dont la fin est encore à plus de 6 h est un reliquat : créée
       une fois puis jamais clôturée, elle encaisse tous les dons du streamer depuis le
       début. Les vraies sont des one-shots de 5 à 30 minutes. */
    const STALE = 6 * 3600
    const stale = new Set(real.filter(x => !x.drawn && (x.endTs ?? 0) > t + STALE).map(x => x.id))
    const all = real.filter(x => !stale.has(x.id))
    const live = new Map(this.sql.exec('SELECT twitch_id, login, live, viewers FROM streamers').toArray()
      .map(r => [r.login, r]))
    const deco = x => ({ ...x, live: !!live.get(x.login)?.live, viewers: live.get(x.login)?.viewers ?? 0 })
    const active = all.filter(x => !x.drawn && (x.endTs ?? 0) > t).map(deco)
    const pending = all.filter(x => !x.drawn && (x.endTs ?? 0) <= t).map(deco)
    const past = all.filter(x => x.drawn).map(deco)
    return {
      at: Date.now(), now: t,
      event: { name: this.meta('event_name'), start: Number(this.meta('event_start', 0)) || null, end: Number(this.meta('event_end', 0)) || null },
      active: active.sort((a, b) => (a.endTs ?? 9e9) - (b.endTs ?? 9e9)),
      pending: pending.sort((a, b) => (b.endTs ?? 0) - (a.endTs ?? 0)),
      past: past.sort((a, b) => (b.endTs ?? 0) - (a.endTs ?? 0)).slice(0, 120),
      winners: past.flatMap(x => x.winners.map((w, i) => ({
        key: x.id + ':' + i, name: w.name, cents: w.cents,
        streamer: x.streamer, login: x.login, lot: x.name, endTs: x.endTs, mode: x.mode,
      }))).sort((a, b) => (b.endTs ?? 0) - (a.endTs ?? 0)).slice(0, 400),
      stats: {
        active: active.length, pending: pending.length, drawn: past.length,
        known: all.length, hidden: raw.length - real.length, stale: stale.size,
        cents: all.reduce((a, x) => a + (x.cents || 0), 0),
        dons: all.reduce((a, x) => a + (x.nDons || 0), 0),
        winners: past.reduce((a, x) => a + x.winners.length, 0),
        streamers: Number(this.meta('streamers_n', 0)),
        seeded: Number(this.meta('seeded_n', 0)),
        pendingSeed: this.sql.exec('SELECT COUNT(*) n FROM tombolas WHERE last_seen=0').toArray()[0]?.n ?? 0,
        scanAt: Number(this.meta('scan_at', 0)) || null,
        scanUsed: Number(this.meta('scan_used', 0)),
        rateLimitedAt: Number(this.meta('rate_limited_at', 0)) || null,
        tickSeconds: TICK_MS / 1000,
      },
    }
  }
}

const stub = env => env.SCANNER.get(env.SCANNER.idFromName('main'))

export default {
  async fetch (req, env, ctx) {
    const u = new URL(req.url)
    // Balise de fréquentation : un appel par chargement de page, pas par sondage.
    if (u.pathname === '/api/hit') {
      const vid = u.searchParams.get('v') || ''
      const kind = u.searchParams.get('k') || 'view'
      if (!KINDS.has(kind)) return new Response(null, { status: 204 })
      ctx.waitUntil(stub(env).fetch(`https://do/hit?k=${kind}&v=${encodeURIComponent(vid)}`))
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } })
    }
    if (u.pathname === '/api/stats') {
      const r = await stub(env).fetch('https://do/stats')
      return new Response(r.body, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' },
      })
    }
    if (u.pathname === '/api/tombolas') {
      /* Cache d'arête explicite. Une réponse de Worker n'est pas mise en cache
         automatiquement : sans ce bloc, chaque sondage de chaque visiteur réveillerait
         le Durable Object. Avec, l'objet n'est sollicité qu'une fois toutes les 4 s
         quel que soit le nombre de visiteurs. */
      const key = new Request(new URL('/api/tombolas', u.origin), { method: 'GET' })
      const cache = caches.default
      const hit = await cache.match(key)
      if (hit) return hit
      ctx.waitUntil(stub(env).fetch('https://do/hit?k=api'))
      const r = await stub(env).fetch('https://do/payload')
      const res = new Response(r.body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=3, s-maxage=4',
          'access-control-allow-origin': '*',
        },
      })
      ctx.waitUntil(cache.put(key, res.clone()))
      return res
    }
    // Sans correspondance dans public/, on renvoie la page : le front est une seule page.
    return env.ASSETS ? env.ASSETS.fetch(req) : new Response('not found', { status: 404 })
  },

  // Filet de sécurité : réarme l'alarme si elle s'est perdue.
  async scheduled (_ev, env, ctx) {
    ctx.waitUntil(stub(env).fetch('https://do/scan'))
  },
}
