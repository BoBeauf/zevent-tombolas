/* Tombolas ZEvent — front. Lecture seule, aucune donnée envoyée nulle part :
   le pseudo saisi pour vérifier les gains reste dans le navigateur. */
const $ = s => document.querySelector(s)
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e }
const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
const EUR2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const NUM = new Intl.NumberFormat('fr-FR')
const eur = c => EUR.format((c || 0) / 100)
const eur2 = c => EUR2.format((c || 0) / 100)
const num = n => NUM.format(Math.round(n || 0))
const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]))
const hhmm = ts => new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

// mm:ss tant qu'il reste moins d'une heure — c'est l'échelle d'une tombola
function cd (s) {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}

const TWITCH = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.3 0 1 3.6v16.8h5.7V24l3.4-3.6h2.8L19.7 14V0H4.3zm13.1 13-3.1 3.3h-3.1L8.4 19v-2.7H4.9V1.8h12.5V13zM14 5.2h1.8v5.2H14V5.2zm-4.6 0h1.8v5.2H9.4V5.2z"/></svg>'
const HEART = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.7-9.6-9A5.6 5.6 0 0 1 12 6.2 5.6 5.6 0 0 1 21.6 12c-2.1 4.3-9.6 9-9.6 9z"/></svg>'
const MODE = {
  classic: 'Un ticket par euro donné : plus le don est gros, plus la chance est grande.',
  donator_email: 'Un ticket par donateur : chacun a la même chance, quel que soit le montant.',
}

let D = null
let ME = ''
try { ME = localStorage.getItem('zt.me') || '' } catch {}
let NOTIF = false
try { NOTIF = localStorage.getItem('zt.notif') === '1' } catch {}
let seen = null   // null au premier chargement : on mémorise sans alerter
const notified = new Set()
try { for (const k of JSON.parse(localStorage.getItem('zt.notified') || '[]')) notified.add(k) } catch {}

/* ------------------------------------------------------------------ données */
async function tick () {
  try {
    const r = await fetch('/api/tombolas', { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(r.status)
    D = await r.json()
    render()
    checkNew()
  } catch {
    if (!D) $('#headline').textContent = 'Service momentanément indisponible.'
  }
}

function checkNew () {
  const act = D?.active || []
  if (seen === null) { seen = new Set(act.map(x => x.id)); return }
  for (const x of act) {
    if (seen.has(x.id)) continue
    seen.add(x.id)
    if (!NOTIF) continue
    toast(`<div class="t1">🎟️ Nouvelle tombola chez <b>${esc(x.streamer || '?')}</b></div>
      <div class="t2">${esc(x.name || 'Sans intitulé')} — ${x.endTs ? 'fin dans ' + cd(x.endTs - D.now) : 'en cours'}</div>`)
    if (window.Notification && Notification.permission === 'granted' && !notified.has(x.id)) {
      notified.add(x.id)
      try { localStorage.setItem('zt.notified', JSON.stringify([...notified].slice(-200))) } catch {}
      try {
        const n = new Notification(`🎟️ Tombola chez ${x.streamer || '?'}`, {
          body: `${x.name || 'Tombola'} — ${x.endTs ? 'fin dans ' + cd(x.endTs - D.now) : 'en cours'}`,
          tag: 'zt:' + x.id, icon: x.avatar || undefined,
        })
        n.onclick = () => { window.focus(); n.close() }
      } catch {}
    }
  }
  if (seen.size > 800) seen = new Set(act.map(x => x.id))
}

/* ------------------------------------------------------------------- rendu */
function render () {
  if (!D) return
  const S = D.stats
  const n = D.active.length
  $('#headline').innerHTML = n
    ? `<span class="hot">${n} tombola${n > 1 ? 's' : ''}</span> en cours, là, maintenant.`
    : D.pending.length
      ? `Tirage imminent sur ${D.pending.length} tombola${D.pending.length > 1 ? 's' : ''}.`
      : 'Aucune tombola en cours pour le moment.'
  $('#sub').textContent = n
    ? 'Un don sur la cagnotte du streamer vaut ticket de participation.'
    : `Le scanner passe en revue les ${num(S.streamers)} participants en continu — cette page se met à jour toute seule.`

  const p = $('#heropills'); p.innerHTML = ''
  const pill = h => p.append(el('div', 'p', h))
  pill(`<b>${num(S.drawn)}</b> tirages effectués`)
  pill(`<b>${num(S.winners)}</b> gagnants`)
  pill(`<b>${eur(S.cents)}</b> récoltés via tombolas`)
  pill(`<b>${num(S.dons)}</b> participations`)

  $('#nactive').textContent = D.active.length
  $('#npending').textContent = D.pending.length
  $('#npast').textContent = D.past.length
  $('#pendingwrap').hidden = !D.pending.length

  renderTop()
  fill('#active', D.active, 'Aucune tombola ouverte à cet instant. Ça bouge vite : garde la page ouverte.')
  fill('#pending', D.pending, '')
  renderPast()
  renderVerdict()

  const age = S.scanAt ? D.now - S.scanAt : null
  $('#foot').innerHTML = `Scanner actif : ${S.scanUsed} requêtes toutes les ${S.tickSeconds} s`
    + (age != null ? ` · dernier passage il y a ${age} s` : '')
    + ` · ${num(S.known)} tombolas connues`
    + (S.hidden ? ` · ${S.hidden} test${S.hidden > 1 ? 's' : ''} écarté${S.hidden > 1 ? 's' : ''}` : '')
    + (S.stale ? ` · ${S.stale} reliquat${S.stale > 1 ? 's' : ''} masqué${S.stale > 1 ? 's' : ''}` : '')
    + (S.rateLimitedAt && D.now - S.rateLimitedAt < 120 ? ' · <b style="color:var(--gold)">ralenti par l\'API</b>' : '')
}

/* Classement par streamer, cumul de toutes ses tombolas. */
function renderTop () {
  const box = $('#top'); if (!box) return
  const T = D.top || []
  $('#ntop').textContent = T.length
  $('#topwrap').hidden = !T.length
  const max = T.length ? T[0].cents : 1
  box.innerHTML = T.map((x, i) => `<div class="ld">
    <div class="rk">${i + 1}</div>
    ${x.avatar ? `<img src="${esc(x.avatar)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
    <div class="who4">
      <div class="nm2">${x.login
        ? `<a href="https://twitch.tv/${esc(x.login)}" target="_blank" rel="noopener">${esc(x.streamer || '?')}</a>`
        : esc(x.streamer || '?')}${x.live ? '<span class="dot on"></span>' : ''}</div>
      <div class="sub2">${x.n} tombola${x.n > 1 ? 's' : ''} · ${num(x.dons)} participations${x.drawn < x.n ? ` · ${x.n - x.drawn} en cours` : ''}</div>
    </div>
    <div class="bar2"><div style="width:${(100 * x.cents / max).toFixed(1)}%"></div></div>
    <div class="amt2">${eur(x.cents)}</div>
  </div>`).join('')
  for (const a of box.querySelectorAll('a')) a.addEventListener('click', () => track('twitch'))
}

function fill (sel, list, vide) {
  const box = $(sel); box.innerHTML = ''
  if (!list.length) { if (vide) box.append(el('div', 'empty', vide)); return }
  for (const x of list) box.append(card(x))
}

function card (x) {
  const reste = x.endTs ? x.endTs - D.now : null
  const attente = !x.drawn && reste != null && reste <= 0
  const urgent = reste != null && reste > 0 && reste < 300
  const c = el('div', 'tk-card' + (x.live ? ' live' : '') + (urgent ? ' soon' : '') + (x.highValue ? ' gold' : ''))
  const badges = [
    x.highValue ? '<span class="tag gold">gros lot</span>' : '',
    attente ? '<span class="tag hot">tirage imminent</span>' : urgent ? '<span class="tag hot">bientôt fini</span>' : '',
    x.nWinners > 1 ? `<span class="tag">${x.nWinners} gagnants</span>` : '',
  ].filter(Boolean).join('')

  c.innerHTML = `
    <div class="who">
      ${x.avatar ? `<img src="${esc(x.avatar)}" alt="" loading="lazy">` : ''}
      <div style="min-width:0">
        <div class="nm">${esc(x.streamer || '?')}</div>
        <div class="st"><span class="dot ${x.live ? 'on' : ''}"></span>${x.live ? num(x.viewers) + ' viewers' : 'hors ligne'}</div>
      </div>
      <div class="badges">${badges}</div>
    </div>
    <div class="lot">${esc(x.name || 'Sans intitulé')}</div>
    <div class="nums">
      <div><div class="k">Collecté</div><div class="v">${eur(x.cents)}</div></div>
      <div><div class="k">Participations</div><div class="v">${num(x.nDons)}</div></div>
      <div><div class="k">${x.drawn ? 'Tirée à' : attente ? 'Finie depuis' : 'Fin dans'}</div>
        <div class="v cd${urgent ? ' urgent' : ''}" ${x.endTs && !x.drawn ? `data-end="${x.endTs}"` : ''}>
          ${x.endTs ? (x.drawn ? hhmm(x.endTs) : cd(Math.abs(reste))) : '—'}</div></div>
    </div>
    ${x.mode ? `<div class="mode">${esc(MODE[x.mode] || x.mode)}</div>` : ''}
    ${x.login ? `<div class="acts">
      <a class="btn-tw${x.live ? '' : ' off'}" href="https://twitch.tv/${esc(x.login)}" target="_blank" rel="noopener">${TWITCH}${x.live ? 'Regarder' : 'La chaîne'}</a>
      ${x.drawn ? '' : `<a class="btn-don" href="https://zevent.fr/don/${esc(x.login)}" target="_blank" rel="noopener">${HEART}Participer</a>`}
    </div>` : ''}`
  const tw = c.querySelector('.btn-tw'); if (tw) tw.addEventListener('click', () => track('twitch'))
  const dn = c.querySelector('.btn-don'); if (dn) dn.addEventListener('click', () => track('don'))
  return c
}

function renderPast () {
  const box = $('#past'); box.innerHTML = ''
  if (!D.past.length) { box.append(el('div', 'empty', 'Aucun tirage effectué pour le moment.')); return }
  for (const x of D.past.slice(0, 60)) {
    const mine = x.winners.some(w => match(w.name))
    const r = el('div', 'res' + (mine ? ' me' : ''))
    r.innerHTML = `${x.avatar ? `<img src="${esc(x.avatar)}" alt="" loading="lazy">` : ''}
      <div class="g">
        <div class="t">${esc(x.streamer || '?')} <span class="amt" style="color:var(--dim);font-weight:600">· ${eur(x.cents)}</span></div>
        <div class="s">${esc((x.name || '').slice(0, 70))} · tirée à ${x.endTs ? hhmm(x.endTs) : '—'} · ${num(x.nDons)} participations</div>
      </div>
      <div class="w">${x.winners.length
        ? x.winners.map(w => `<b>${esc(w.name || 'anonyme')}</b>`).join(', ')
        : '<span style="color:var(--dim2)">gagnant non publié</span>'}</div>`
    box.append(r)
  }
}

/* --------------------------------------------------- ai-je gagné ? (local) */
const norm = v => String(v || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
function match (name) {
  const me = norm(ME); if (me.length < 2) return null
  const n = norm(name)
  if (n === me) return 'exact'
  if (n.length >= 4 && me.length >= 4 && (n.includes(me) || me.includes(n))) return 'proche'
  return null
}

function renderVerdict () {
  const v = $('#verdict'); v.innerHTML = ''
  if (!ME || !D) return
  const hits = (D.winners || []).map(w => ({ w, m: match(w.name) })).filter(x => x.m)
  if (hits.length) {
    const b = el('div', 'hit')
    b.innerHTML = `<div class="big">🎉 ${hits.length} tombola${hits.length > 1 ? 's' : ''} gagnée${hits.length > 1 ? 's' : ''} sous « ${esc(ME)} »</div>`
      + hits.slice(0, 12).map(({ w, m }) => `<div>• <b>${esc(w.name)}</b> chez ${esc(w.streamer)} — ${esc(w.lot || '')}
          <span style="color:var(--dim2)">(don de ${eur2(w.cents)}, tiré à ${hhmm(w.endTs)}${m === 'proche' ? ', correspondance approchée' : ''})</span></div>`).join('')
    v.append(b)
  } else {
    v.append(el('div', 'miss', `Aucun gain sous « ${esc(ME)} » sur les ${num((D.winners || []).length)} gagnants connus. La recherche se refait toute seule à chaque tirage.`))
  }
}

/* ------------------------------------------------------------------ toasts */
function toast (html, ttl = 22_000) {
  const t = el('div', 'toast', html + '<button class="x" aria-label="Fermer">✕</button>')
  t.querySelector('.x').onclick = () => t.remove()
  $('#toasts').prepend(t)
  while ($('#toasts').children.length > 3) $('#toasts').lastElementChild.remove()
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300) }, ttl)
}

/* ------------------------------------------------------------- interactions */
function paintBell () {
  const b = $('#bell'), perm = window.Notification ? Notification.permission : 'unsupported'
  b.classList.toggle('on', NOTIF)
  $('#belllbl').textContent = !NOTIF ? 'Alertes'
    : perm === 'granted' ? 'Alertes activées' : 'Alertes (dans la page)'
  b.title = !NOTIF ? 'Être prévenu quand une tombola démarre'
    : perm === 'granted' ? 'Notification système à chaque nouvelle tombola — cliquer pour désactiver'
      : 'Alerte affichée dans la page — les notifications système ne sont pas autorisées'
}
$('#bell').onclick = async () => {
  NOTIF = !NOTIF
  try { localStorage.setItem('zt.notif', NOTIF ? '1' : '0') } catch {}
  track(NOTIF ? 'notif_on' : 'notif_off')
  if (NOTIF && window.Notification && Notification.permission === 'default') {
    try { if (await Notification.requestPermission() === 'granted') track('notif_granted') } catch {}
  }
  paintBell()
  if (NOTIF) toast('<div class="t1">🔔 Alertes activées</div><div class="t2">Tu seras prévenu dès qu\'une tombola démarre.</div>', 6000)
}

const deb = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }
const inp = $('#me')
inp.value = ME
$('#meclear').hidden = !ME
let pseudoTracked = false
inp.oninput = deb(e => {
  ME = e.target.value.trim()
  if (ME.length >= 3 && !pseudoTracked) { pseudoTracked = true; track('pseudo') }
  try { localStorage.setItem('zt.me', ME) } catch {}
  $('#meclear').hidden = !ME
  renderVerdict(); renderPast()
}, 300)
$('#meclear').onclick = () => { inp.value = ''; ME = ''; try { localStorage.removeItem('zt.me') } catch {}; $('#meclear').hidden = true; renderVerdict(); renderPast() }

// Les comptes à rebours tournent en local, à la seconde, sans solliciter le serveur.
setInterval(() => {
  if (!D) return
  const t = Math.floor(Date.now() / 1000)
  for (const n of document.querySelectorAll('.v.cd[data-end]')) {
    const left = Number(n.dataset.end) - t
    n.textContent = cd(Math.abs(left))
    n.classList.toggle('urgent', left > 0 && left < 300)
  }
}, 1000)

/* Cadence adaptative. Le plan gratuit de Cloudflare plafonne à 100 000 requêtes par
   jour : un seul visiteur qui sonderait toutes les 5 secondes en consommerait 17 280.
   On ne sonde vite que quand il se passe quelque chose — et pas du tout quand l'onglet
   est en arrière-plan, où il n'y a personne pour regarder. */
let timer = null, every = 0
function schedule () {
  const want = document.hidden ? 60_000 : (D?.active?.length || D?.pending?.length) ? 5_000 : 20_000
  if (want === every) return
  every = want
  clearInterval(timer)
  timer = setInterval(tick, want)
}
/* Mesure d'usage. L'identifiant est tiré au sort dans le navigateur — aucune IP, aucun
   cookie, aucun tiers : il sert seulement à ne pas compter dix fois la même personne
   dans la journée. Seuls des compteurs agrégés sont conservés côté serveur. */
let VID = ''
try {
  VID = localStorage.getItem('zt.vid') || ''
  if (!VID) { VID = Math.random().toString(36).slice(2, 12); localStorage.setItem('zt.vid', VID) }
} catch {}
function track (kind) {
  const u = `/api/hit?k=${kind}&v=${encodeURIComponent(VID)}`
  // sendBeacon survit à la navigation : un clic sur « Participer » quitte la page,
  // et un fetch classique serait annulé avant d'être parti.
  try { if (navigator.sendBeacon && navigator.sendBeacon(u)) return } catch {}
  fetch(u, { keepalive: true }).catch(() => {})
}
track('view')

const td = $('#topdon'); if (td) td.addEventListener('click', () => track('don'))

paintBell()
tick().then(schedule)
document.addEventListener('visibilitychange', () => {
  schedule()
  if (!document.hidden) tick()
})
const _render = render
render = function () { _render(); schedule() }
