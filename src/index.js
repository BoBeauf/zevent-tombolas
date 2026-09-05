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
/* Sur le plan payant, Cloudflare n'est plus le facteur limitant : à 10 s on consomme
   0,16 % des lectures incluses. C'est l'API des organisateurs qui borne la cadence — elle
   renvoie des 429 en rafale au-delà d'environ 2,9 requêtes par seconde (mesuré : 276
   réponses 429 sur 339 requêtes à concurrence 4). 25 requêtes toutes les 10 s font
   2,5 req/s, cadence sur laquelle aucun 429 n'a été observé en 38 balayages complets. */
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
      /* Sans ces index, chaque « ORDER BY last_scan LIMIT n » balayait les 341 lignes de
         streamers — trois fois par réveil, 8 640 fois par jour, soit 8,8 M lignes lues
         par jour à elles seules. Avec, on ne lit que les n lignes demandées. */
      CREATE INDEX IF NOT EXISTS i_str_scan ON streamers(last_scan);
      CREATE INDEX IF NOT EXISTS i_str_live_scan ON streamers(live, last_scan);
      CREATE INDEX IF NOT EXISTS i_str_ever ON streamers(live, ever, last_scan);
      /* Fréquentation. Le tableau de bord Cloudflare compte les requêtes, ce qui mélange
         chargements de page et sondages d'API — on compte donc les visites nous-mêmes.
         « vid » est un identifiant aléatoire tiré par le navigateur, sans lien avec l'IP :
         il permet de distinguer deux visites du même visiteur, rien d'autre. */
      CREATE TABLE IF NOT EXISTS hits(day TEXT, kind TEXT, n INTEGER, PRIMARY KEY(day, kind));
      CREATE TABLE IF NOT EXISTS visitors(day TEXT, vid TEXT, PRIMARY KEY(day, vid));
      -- personnes distinctes par type d'événement (alerte activée, clic don, clic Twitch…)
      CREATE TABLE IF NOT EXISTS ev(day TEXT, kind TEXT, vid TEXT, PRIMARY KEY(day, kind, vid));
      -- la purge filtre sur la colonne day : sans index elle balaie toute la table
      CREATE INDEX IF NOT EXISTS i_hits_day ON hits(day);
      CREATE INDEX IF NOT EXISTS i_vis_day ON visitors(day);
      CREATE INDEX IF NOT EXISTS i_ev_day ON ev(day);
    `)
    /* Caches mémoire. Le Durable Object est un processus qui vit entre les requêtes :
       tout ce qui est relu à l'identique n'a aucune raison de repasser par SQLite, et
       chaque ligne lue compte dans le quota du plan gratuit. */
    this.cache = { at: 0, v: null }      // payload rendu
    /* La liste des participants est RECONSTRUITE depuis l'API toutes les 3 minutes :
       la persister en base n'apportait rien et coûtait 341 écritures par rafraîchissement,
       soit 164 000 par jour — l'essentiel du quota d'écritures du plan gratuit. Elle vit
       donc en mémoire. Au redémarrage de l'objet, le premier rafraîchissement la remplit,
       et le drapeau « a déjà lancé une tombola » se déduit de la table tombolas. */
    this.st = new Map()                  // twitch_id -> fiche du streamer
    this.stLoaded = false
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
  /* Poser une alarme est une ÉCRITURE. Quand le quota d'écritures du plan gratuit est
     atteint, elle échoue — et comme arm() est appelée au début de chaque requête, c'est
     tout l'objet qui devient injoignable, y compris pour de la simple lecture. On isole
     donc l'échec : la lecture continue de fonctionner même si la replanification échoue. */
  async arm () {
    try {
      const a = await this.ctx.storage.getAlarm()
      /* Une alarme dont l'heure est passée ne se déclenchera jamais : c'est ce qui arrive
         quand la replanification échoue (quota d'écritures atteint) au moment où l'alarme
         se consomme. On la reposait alors « seulement si absente » — et elle n'était pas
         absente, juste morte. Le scanner restait à l'arrêt même une fois le quota rétabli. */
      if (a == null || a < Date.now() - 60_000) await this.ctx.storage.setAlarm(Date.now() + 1000)
    } catch (e) {
      this.armError = String(e.message || e)
    }
  }

  async fetch (req) {
    const u = new URL(req.url)
    await this.arm()
    if (u.pathname === '/scan') return new Response('ok')
    if (u.pathname === '/hit') { this.hit(u.searchParams.get('v'), u.searchParams.get('k') || 'view'); return new Response('ok') }
    if (u.pathname === '/stats') return Response.json(this.stats())
    /* Le payload coûte ~135 lignes lues. Le reconstruire à chaque requête revenait à
       2,9 M lignes par jour : on le garde 20 s en mémoire, ce qui ne change rien à
       l'affichage (le scan tourne toutes les 15 s et les comptes à rebours sont calculés
       dans le navigateur). */
    if (Date.now() - this.cache.at > 8_000 || !this.cache.v) {
      this.cache = { at: Date.now(), v: JSON.stringify(this.payload()) }
    }
    return new Response(this.cache.v, { headers: { 'content-type': 'application/json' } })
  }

  hit (vid, kind) {
    const day = new Date().toISOString().slice(0, 10)
    this.sql.exec('INSERT INTO hits(day,kind,n) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET n=n+1', day, kind)
    const v = vid ? String(vid).slice(0, 24) : null
    if (v && kind === 'view') this.sql.exec('INSERT OR IGNORE INTO visitors(day,vid) VALUES(?,?)', day, v)
    else if (v) this.sql.exec('INSERT OR IGNORE INTO ev(day,kind,vid) VALUES(?,?,?)', day, kind, v)
    this.purge()
  }

  /* Purge des données de plus de 30 jours. Elle tournait à CHAQUE visite et à chaque
     clic : trois DELETE filtrant sur `day`, sans index, donc trois balayages complets.
     Comme la table `visitors` grossit d'une ligne par visiteur et par jour, le coût
     devenait quadratique — 1 000 visiteurs = 1 M de lignes lues rien que pour ça,
     10 000 visiteurs = 100 M. C'est ce qui aurait explosé le jour où le lien marche.
     Une fois par heure suffit largement pour une rétention de 30 jours. */
  purge () {
    if (Date.now() - (this.purgedAt || 0) < 3_600_000) return
    this.purgedAt = Date.now()
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

  // Reconstitue le drapeau « ever » (a déjà lancé une tombola) après un redémarrage,
  // en une seule requête au lieu de le persister ligne par ligne.
  loadEver () {
    if (this.stLoaded) return
    this.stLoaded = true
    for (const r of this.sql.exec('SELECT DISTINCT twitch_id FROM tombolas WHERE twitch_id IS NOT NULL').toArray()) {
      this.everSet = this.everSet || new Set()
      this.everSet.add(String(r.twitch_id))
    }
  }

  // Liste des participants : nom, avatar, login et identifiant Twitch, statut live.
  async refreshStreamers () {
    let id = this.meta('event_id')
    if (!id || now() - Number(this.meta('event_at', 0)) > 3600) id = (await this.refreshEvent()) || id
    if (!id) return
    const list = await this.get(`${EMS}/events/${id}/participations`, 20_000)
    if (!Array.isArray(list)) return
    const t = now()
    this.loadEver()
    for (const p of list) {
      const sm = p.streamers?.[0] || {}
      const tw = sm.socials?.twitch
      if (!tw?.id) continue
      const id = String(tw.id)
      const viewers = (sm.streaming_states || []).reduce((a, x) => a + (x.viewers || 0), 0)
      const prev = this.st.get(id)
      this.st.set(id, {
        twitch_id: id, name: str(p.name), login: str(tw.login), avatar: str(p.profile_url),
        live: p.live ? 1 : 0, cents: p.amount_raised ?? 0, viewers,
        ever: prev?.ever || (this.everSet?.has(id) ? 1 : 0),
        last_scan: prev?.last_scan || 0,
      })
    }
    this.stAt = t
    this.setMeta('streamers_n', list.length)
    this.cache.at = 0
  }

  saveTombola (t, ctx) {
    if (!t?.id) return null
    const ts = now()
    const id = String(t.id)
    /* On relit chaque tombola ouverte toutes les 20 s, mais la plupart du temps rien n'a
       bougé. Réécrire quand même coûtait 78 000 écritures par jour. On compare donc à
       l'état connu et on n'écrit que sur changement réel. `last_seen` n'entre pas dans
       la comparaison : il change à chaque passage, par construction. */
    const sig = JSON.stringify([eurToCents(t.amount), t.number ?? null, t.drawn ? 1 : 0,
      t.end ?? null, t.numberOfWinners ?? null, (t.winners || []).length, (t.top || []).length, str(t.name)])
    this.sigs = this.sigs || new Map()
    if (this.sigs.get(id) === sig) return null          // rien de neuf, aucune écriture
    const prev = this.sql.exec('SELECT id, drawn FROM tombolas WHERE id=?', id).toArray()[0]
    this.sigs.set(id, sig)
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
    if (ctx.twitchId) { const f = this.st.get(String(ctx.twitchId)); if (f) f.ever = 1 }
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
    const fiche = id => this.st.get(String(id)) || {}
    // A — tombolas ouvertes, relues par identifiant. Seule file qui touche la base,
    // et elle est servie par l'index i_tb_drawn.
    push(this.sql.exec(
      `SELECT id AS byId, twitch_id FROM tombolas
       WHERE drawn=0 AND (end_ts IS NULL OR end_ts < ?)
       ORDER BY end_ts DESC LIMIT 12`, t + 6 * 3600).toArray()
      .map(r => { const f = fiche(r.twitch_id); return { ...r, name: f.name, login: f.login, avatar: f.avatar } }))

    /* B, C et D se calculent désormais sur la liste en mémoire : plus aucune lecture ni
       écriture en base pour choisir qui scanner. C'est ce qui supprime les 108 000
       UPDATE last_scan quotidiens. */
    const all = [...this.st.values()]
    const parScan = (arr) => arr.sort((a, b) => a.last_scan - b.last_scan)
    const reserve = 3
    push(parScan(all.filter(x => x.live && x.ever)).slice(0, Math.ceil(budget * 0.35)))
    push(parScan(all.filter(x => x.live)).slice(0, Math.max(0, budget - out.length - reserve)))
    push(parScan(all).slice(0, budget))
    return out
  }

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

  touch (twitchId) {
    const f = twitchId && this.st.get(String(twitchId))
    if (f) f.last_scan = now()
  }

  async alarm () {
    const t0 = Date.now()
    let used = 0, hits = 0, rate = false
    const events = []
    try {
      /* Le marqueur de fraîcheur DOIT vivre en mémoire, comme la liste elle-même :
         s'il était lu en base, l'objet croirait la liste à jour après un redémarrage
         alors que la mémoire est vide — plus aucun streamer en live, et les files B, C
         et D sans rien à parcourir. On force donc aussi le rafraîchissement si la carte
         est vide, quelle que soit la date du dernier appel. */
      if (this.st.size === 0 || now() - (this.stAt || 0) > 180) {
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
          this.touch(it.twitch_id)
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
          this.touch(it.twitch_id)
        }
      }
      if (hits) this.cache.at = 0        // des tombolas ont changé : payload à refaire
      // écrites une fois par minute : elles ne servent qu'à l'affichage de /stats
      this.scanAt = now(); this.scanUsed = used
      if (Date.now() - (this.metaAt || 0) > 60_000) {
        this.metaAt = Date.now()
        this.setMeta('scan_at', this.scanAt)
        this.setMeta('scan_used', used)
      }
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
    // relue seulement après un rafraîchissement de la liste (toutes les 3 min), pas à
    // chaque construction du payload
    const live = new Map([...this.st.values()].map(r => [r.login, r]))
    const deco = x => ({ ...x, live: !!live.get(x.login)?.live, viewers: live.get(x.login)?.viewers ?? 0 })
    /* Classement des cagnottes par ce que leurs tombolas ont rapporté. On agrège par
       streamer plutôt que par tombola : la plupart en lancent plusieurs, et c'est le
       cumul qui est parlant. Même base que le reste (essais et reliquats déjà écartés). */
    const byS = new Map()
    for (const x of all) {
      const k = x.login || x.streamer || x.id
      const e = byS.get(k) || { streamer: x.streamer, login: x.login, avatar: x.avatar, cents: 0, dons: 0, n: 0, drawn: 0, lastTs: 0 }
      e.cents += x.cents || 0; e.dons += x.nDons || 0; e.n++
      if (x.drawn) e.drawn++
      if ((x.endTs ?? 0) > e.lastTs) e.lastTs = x.endTs ?? 0
      byS.set(k, e)
    }
    const top = [...byS.values()].sort((a, b) => b.cents - a.cents).slice(0, 10)
      .map(x => ({ ...x, live: !!live.get(x.login)?.live, viewers: live.get(x.login)?.viewers ?? 0 }))

    const active = all.filter(x => !x.drawn && (x.endTs ?? 0) > t).map(deco)
    const pending = all.filter(x => !x.drawn && (x.endTs ?? 0) <= t).map(deco)
    const past = all.filter(x => x.drawn).map(deco)
    return {
      at: Date.now(), now: t,
      event: { name: this.meta('event_name'), start: Number(this.meta('event_start', 0)) || null, end: Number(this.meta('event_end', 0)) || null },
      top,
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
        streamers: this.st.size || Number(this.meta('streamers_n', 0)),
        streamersReady: this.st.size > 0,
        seeded: Number(this.meta('seeded_n', 0)),
        pendingSeed: this.sql.exec('SELECT COUNT(*) n FROM tombolas WHERE last_seen=0').toArray()[0]?.n ?? 0,
        scanAt: this.scanAt || Number(this.meta('scan_at', 0)) || null,
        scanUsed: this.scanUsed ?? Number(this.meta('scan_used', 0)),
        rateLimitedAt: Number(this.meta('rate_limited_at', 0)) || null,
        tickSeconds: TICK_MS / 1000,
      },
    }
  }
}

/* Nom de l'instance du Durable Object. En changer crée une instance NEUVE, avec un
   stockage vide : les tombolas se réamorcent depuis src/seed.json en quelques minutes,
   mais les compteurs de fréquentation sont perdus. Ce levier n'a d'intérêt que si une
   instance devient définitivement inutilisable — ça n'a pas servi lors du blocage de
   quota du 5 septembre, que le passage en plan payant a fini par lever de lui-même. */
const SCANNER_ID = 'main'
const stub = env => env.SCANNER.get(env.SCANNER.idFromName(SCANNER_ID))

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
      try {
        const r = await stub(env).fetch('https://do/stats')
        if (!r.ok) throw new Error('DO ' + r.status)
        return new Response(r.body, {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' },
        })
      } catch (e) {
        // quota atteint ou incident : on le dit clairement au lieu de renvoyer une 500
        return new Response(JSON.stringify({ unavailable: true, reason: String(e.message || e) }), {
          status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
    }
    if (u.pathname === '/api/tombolas') {
      /* Cache d'arête explicite. Une réponse de Worker n'est pas mise en cache
         automatiquement : sans ce bloc, chaque sondage de chaque visiteur réveillerait
         le Durable Object. Avec, l'objet n'est sollicité qu'une fois toutes les 4 s
         quel que soit le nombre de visiteurs. */
      const key = new Request(new URL('/api/tombolas', u.origin), { method: 'GET' })
      // Copie de secours, gardée 1 h : elle sert si le Durable Object refuse de répondre
      // (quota de lignes lues atteint, incident). Le site affiche alors des données un
      // peu datées plutôt que « service indisponible ».
      const backupKey = new Request(new URL('/api/tombolas-secours', u.origin), { method: 'GET' })
      const cache = caches.default
      const hit = await cache.match(key)
      if (hit) {
        // même servi depuis le cache, on s'assure de temps en temps que l'alarme vit
        if (Math.random() < 0.02) ctx.waitUntil(stub(env).fetch('https://do/scan').catch(() => {}))
        return hit
      }
      try {
        ctx.waitUntil(stub(env).fetch('https://do/hit?k=api'))
        const r = await stub(env).fetch('https://do/payload')
        if (!r.ok) throw new Error('DO ' + r.status)
        const body = await r.text()
        const mk = (ttl, extra = {}) => new Response(body, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': `public, max-age=3, s-maxage=${ttl}`,
            'access-control-allow-origin': '*', ...extra,
          },
        })
        const res = mk(5)
        ctx.waitUntil(cache.put(key, res.clone()))
        ctx.waitUntil(cache.put(backupKey, mk(43200)))   // 12 h : couvre une coupure jusqu'au reset
        return res
      } catch (e) {
        const old = await cache.match(backupKey)
        if (old) {
          const h = new Headers(old.headers)
          h.set('x-stale', '1')
          h.set('cache-control', 'public, max-age=15')
          return new Response(old.body, { headers: h })
        }
        return new Response(JSON.stringify({ error: 'indisponible', at: Date.now() }), {
          status: 503, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        })
      }
    }
    // Sans correspondance dans public/, on renvoie la page : le front est une seule page.
    return env.ASSETS ? env.ASSETS.fetch(req) : new Response('not found', { status: 404 })
  },

  // Filet de sécurité : réarme l'alarme si elle s'est perdue.
  async scheduled (_ev, env, ctx) {
    ctx.waitUntil(stub(env).fetch('https://do/scan'))
  },
}
