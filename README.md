# Tombolas ZEvent

Qui lance une tombola au ZEvent, **là, maintenant** — combien de temps il reste, comment
participer, et qui a gagné.

Pendant l'event, les streamers lancent des tombolas : chaque don sur leur cagnotte vaut
ticket de participation, et un tirage désigne le ou les gagnants au bout de 5 à 30 minutes.
Le problème, c'est qu'il n'existe aucune liste : le module officiel n'expose une tombola
que sur la chaîne du streamer concerné, et l'overlay est optionnel. On peut donc passer à
côté d'un tirage qui se joue à l'instant sur une chaîne qu'on ne regardait pas.

Cette page balaie les ~340 participants en continu et affiche celles qui sont ouvertes.

- **Aucune écriture, aucune authentification, aucun compte.** Uniquement des `GET` sur des
  endpoints publics.
- **Aucune donnée personnelle collectée.** Le pseudo saisi pour vérifier ses gains ne
  quitte jamais le navigateur (`localStorage`).
- Projet indépendant, sans lien avec l'organisation du ZEvent.

## Déployer

```bash
npm install
npx wrangler login
npx wrangler deploy
```

C'est tout : ça publie sur `https://zevent-tombolas.<ton-sous-domaine>.workers.dev`.
Aucune configuration, aucune clé d'API, aucune base à provisionner — le Durable Object et
son stockage SQLite sont créés au premier démarrage.

Pour développer en local : `npm run dev`, puis `npx wrangler tail` une fois déployé pour
suivre les journaux.

## Pourquoi Cloudflare Workers

Le scanner doit tourner **en permanence** : une tombola dure 5 à 30 minutes, un balayage
trop lent la découvre après coup. C'est ce qui disqualifie Vercel et Netlify (systèmes de
fichiers éphémères, cron plafonné à une exécution par jour sur les offres gratuites), et
les offres qui endorment le service au bout de quelques minutes d'inactivité.

Le point délicat sur Workers : le plan gratuit plafonne à **50 sous-requêtes par
invocation**, et les Cron Triggers ont une granularité minimale d'**une minute**. Un cron
ne pourrait donc pas dépasser 0,8 requête par seconde — insuffisant.

D'où l'architecture retenue : un **Durable Object** qui se réveille par **alarme**, et
non par cron. Une alarme se replanifie librement en dessous de la minute, et chaque
réveil dispose de son propre budget de 50 sous-requêtes.

| Contrainte | Choix retenu |
|---|---|
| Cadence du scan | alarme toutes les **10 s**, 25 requêtes par réveil = **2,5 req/s** |
| Rate limit de `api.zevent.fr` | mesuré : 276 réponses `429` sur 339 requêtes en rafale à concurrence 4. À 2,5 req/s en série : **zéro 429** sur des heures de scan. Recul automatique ×6 en cas de `429`. |
| Persistance | SQLite du Durable Object — gratuit sur le plan Free, aucune base externe |
| Robustesse | un Cron Trigger toutes les 5 min réarme l'alarme si elle se perdait (redéploiement, incident) |

### Tenir dans le plan gratuit

Le plan gratuit donne **100 000 requêtes par jour**. Un seul visiteur qui sonderait toutes
les 5 secondes en consommerait 17 280 à lui seul. Deux mécanismes évitent ça :

1. **Cache d'arête explicite** (`caches.default`, 4 s). Une réponse de Worker n'est pas
   mise en cache automatiquement : sans ce bloc, chaque sondage réveillerait le Durable
   Object. Avec, l'objet n'est sollicité qu'une fois toutes les 4 s **quel que soit le
   nombre de visiteurs**.
2. **Cadence de sondage adaptative** côté client : 5 s quand une tombola est ouverte,
   20 s quand il ne se passe rien, 60 s quand l'onglet est en arrière-plan. On ne sonde
   vite que quand il y a quelque chose à voir.

Le scanner lui-même consomme ~8 600 réveils par jour, largement dans les clous.

## Comment le scan est priorisé

Le budget de 25 requêtes par réveil est réparti en quatre files, la plus prioritaire
d'abord :

| File | Cible | Tour complet |
|---|---|---|
| **A** | tombolas ouvertes, relues par identifiant | à chaque réveil (10 s) |
| **B** | streamers en live **ayant déjà lancé une tombola** | ~1 min |
| **C** | streamers en live | ~2 min |
| **D** | tous les participants | ~2,5 min |

La file B repose sur une observation : sur une édition, **31 des 215 streamers en live**
avaient déjà lancé une tombola. Ce préalable concentre le budget là où une nouvelle
tombola a réellement des chances d'apparaître, et fait tomber le délai de détection à
une minute pour les streamers coutumiers du fait.

## Deux pièges de l'API, et comment ils sont traités

**Les montants sont en euros, pas en centimes.** Contrairement à toutes les autres API du
ZEvent, `api.zevent.fr` renvoie des flottants en euros. Vérifié sur des tombolas dont le
total égalait exactement la cagnotte du streamer. Tout est converti en centimes à
l'ingestion.

**Les « reliquats ».** Une tombola non tirée dont la date de fin est encore à plusieurs
heures n'est pas une tombola en cours : c'est une tombola créée une fois puis jamais
clôturée, qui encaisse tous les dons du streamer depuis le début de l'event — d'où un
montant qui rejoint sa cagnotte entière. Les vraies sont des one-shots de 5 à 30 minutes.
Elles sont donc masquées au-delà de 6 h de fin annoncée. Les tombolas d'essai (zéro euro
**et** zéro participation) le sont aussi.

## Amorçage : ce qu'un scanner démarré en retard ne peut pas voir

`/tombola/latest/{twitchId}` ne renvoie que la **dernière** tombola d'un streamer. Un
scanner lancé en cours d'event ne peut donc jamais retrouver les précédentes : mesuré,
**22 des 46 streamers** ayant lancé une tombola en avaient lancé plusieurs, et le scanner
n'en voyait que 38 sur 112.

`/tombola/{id}` fonctionne en revanche pour n'importe quel identifiant connu. `src/seed.json`
contient donc la liste des identifiants observés en direct par le collecteur
[zevent-live](https://github.com/BoBeauf/zevent-live). Au premier réveil, s'il s'agit bien
de la même édition, le scanner insère ces identifiants comme lignes vides ; la file A les
remplit ensuite en interrogeant l'API officielle. **Aucune donnée n'est recopiée dans le
dépôt, uniquement des identifiants** — les montants, gagnants et intitulés viennent tous
de la source.

Un identifiant qui renvoie `404` (tombola supprimée du module par son auteur) est retiré,
pour ne pas occuper une place dans la file indéfiniment.

## Couverture

Seules les tombolas créées dans le **module officiel** (`app.zevent.fr`) sont visibles.
Un streamer qui gère son tirage autrement — bot de chat, overlay maison, annonce à l'oral
— n'apparaîtra pas, même si sa tombola est bien réelle et en cours à l'antenne.

L'édition en cours est **découverte automatiquement** depuis `api.evenmorestats.fr/events`
(celle dont le calendrier contient l'instant présent, sinon la plus récente) : l'outil
survit à l'édition suivante sans redéploiement.

## Régénérer l'aperçu social

`public/og.png` (1200×630) est la vignette affichée sur X, Discord, Slack… Elle est
dessinée en HTML dans `public/og-source.html` et rasterisée avec Chrome :

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --screenshot=public/og.png --window-size=1200,630 \
  "file://$PWD/public/og-source.html"
```

Les URL des balises `og:image`, `og:url` et `twitter:image` sont **absolues** — c'est une
exigence de X. Si tu déploies sur un autre domaine, ce sont les seules lignes à changer
dans `public/index.html`.

X met les aperçus en cache par URL : si l'ancienne carte persiste après un déploiement,
poste le lien avec un paramètre (`?v=2`) pour forcer un nouveau rendu.

## Voir les stats du site

- **`/stats`** — page intégrée : visites et visiteurs distincts du jour, historique sur
  14 jours, jauge de consommation du quota gratuit. Le comptage se fait dans le Durable
  Object, sans cookie, sans IP et sans service tiers : chaque navigateur tire un
  identifiant aléatoire stocké chez lui, qui sert uniquement à ne pas compter dix fois la
  même personne dans la journée. Purge automatique au bout de 30 jours.
- **`GET /api/stats`** — les mêmes chiffres en JSON.
- **Tableau de bord Cloudflare** (Workers & Pages → `zevent-tombolas` → Metrics) — le
  chiffre **autoritaire** pour le quota : requêtes, taux d'erreur, temps CPU. C'est là
  qu'il faut regarder pour savoir si on approche des 100 000 requêtes par jour.
- **`npx wrangler tail`** — les journaux en direct, pratique pour voir passer les erreurs.

## Sources

| Source | Ce qu'on en tire |
|---|---|
| `api.zevent.fr/tombola/latest/{twitchId}` | la tombola en cours d'un streamer |
| `api.zevent.fr/tombola/{id}` | l'état d'une tombola connue (montant, tirage, gagnants) |
| `api.evenmorestats.fr/events` | l'édition en cours et son calendrier |
| `api.evenmorestats.fr/events/{id}/participations` | la liste des participants : nom, avatar, chaîne Twitch, statut live |

## API

`GET /api/tombolas` renvoie l'état complet (~5 ko) :

```jsonc
{
  "active":  [ /* ouvertes : fin non atteinte, tirage pas encore effectué */ ],
  "pending": [ /* fin atteinte, tirage imminent */ ],
  "past":    [ /* tirées, les 120 plus récentes */ ],
  "winners": [ /* liste à plat des gagnants, pour la recherche */ ],
  "stats":   { "active": 4, "drawn": 21, "cents": 34827100, "scanUsed": 25 }
}
```

Les montants sont en **centimes**. `access-control-allow-origin: *`, donc réutilisable
depuis n'importe quelle page.
