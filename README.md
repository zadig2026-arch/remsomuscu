# RemsoMuscu

App web (PWA) sur mesure pour Rémy : programme poids de corps de 12 semaines,
3 séances par semaine d'environ 1 h, haut du corps prioritaire (pecs, largeur du
dos, épaules), beaucoup d'abdos, jambes en entretien, étirements à chaque
séance. Pas de cardio.

Fonctionne hors ligne sur iPhone une fois ajoutée à l'écran d'accueil. Toutes
les données restent sur le téléphone (localStorage + IndexedDB pour les photos).

## Installer sur l'iPhone

1. Ouvrir **https://zadig2026-arch.github.io/remsomuscu/** dans Safari
2. Bouton Partager → « Sur l'écran d'accueil » → Ajouter
3. Lancer l'app depuis l'icône, faire le test de placement, c'est parti

## Comment ça marche

- **Test de placement** au premier lancement (tractions, pompes, dips, pompes
  piquées, relevés de genoux, planche) : l'app place Rémy au bon niveau sur
  chacune des 13 échelles d'exercices.
- **Échelles de progression** : chaque mouvement a de 2 à 6 niveaux (ex.
  tractions : négatives → pronation → prise large → lestées → archer → une
  main). Quand le haut de la fourchette de reps est atteint sur toutes les
  séries deux séances de suite, l'app propose le niveau suivant. Flèches ▼ ▲
  sur chaque exercice pour ajuster à la main.
- **3 séances en rotation** : A Pecs & poussée, B Dos & largeur, C Épaules &
  haut complet. Chaque séance = échauffement 5 min, haut du corps, bloc jambes
  8 min, bloc abdos 8 min, étirements 8 min.
- **3 phases** calculées automatiquement à partir des séances terminées :
  Adaptation (S1-4, 3 séries), Volume (S5-8, 4 séries), Intensité (S9-12,
  dernière série à l'échec).
- **Timers** : repos lancé automatiquement quand une série est cochée, chrono
  de maintien pour les gainages et les étirements. Le décompte tient même
  écran verrouillé.
- **Suivi** : pesée hebdo avec conseils orientés perte de ventre, mensurations
  mensuelles (taille, poitrine, bras, épaules), photos de progression,
  historique des séances.
- **Programme** : détail des séances, des échelles, routine souplesse pour les
  jours off, les 6 règles pour perdre le ventre.
- **Sauvegarde** : export / import JSON dans ⚙ Réglages.

## Développement

```bash
cd Github/Tools/RemsoMuscu
python3 -m http.server 8010
# → http://localhost:8010
```

Le programme complet est dans `data/programme.json` (échelles, séances,
phases, échauffement, étirements, nutrition). Modifier ce fichier suffit pour
changer le programme.

## Déploiement

GitHub Pages sur la branche `main`. À chaque modification :

1. **Bumper `CACHE` dans `sw.js`** (sinon l'iPhone garde l'ancienne version)
2. `git commit` + `git push`

Les démos d'exercices (vignettes animées) viennent de
[free-exercise-db](https://github.com/yuhonas/free-exercise-db) et nécessitent
une connexion ; tout le reste marche hors ligne.
