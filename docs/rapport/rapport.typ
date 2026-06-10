// ──────────────────────────────────────────────
//  rapport.typ — Reverse Engineering du Mayhem Bot
//  Pump Fun / Solana — Février 2026
// ──────────────────────────────────────────────

#import "@preview/fletcher:0.5.8" as fletcher: diagram, node, edge

#set document(title: "Reverse Engineering du Mayhem Bot", author: "Nyrok")
#set page(paper: "a4", margin: (x: 2cm, y: 2cm), numbering: "1")
#set text(font: "Helvetica Neue", size: 7.5pt, lang: "fr")
#set par(justify: true, leading: 0.55em)
#set heading(numbering: "1.1")
#show heading: set text(fill: rgb("#003366"))
#show figure.caption: emph

// ── Heading show rules ──────────────────────────────────────────────────

#show heading.where(level: 1): it => {
  if it.numbering == none {
    // PARTIE — large blue banner
    pagebreak(weak: true)
    v(0.8cm)
    align(center)[
      #block(
        width: 100%,
        fill: rgb("#003366"),
        inset: (x: 1cm, y: 0.6cm),
        radius: 2pt,
      )[
        #text(size: 16pt, weight: "bold", fill: white)[#it.body]
      ]
    ]
    v(0.5cm)
  } else {
    // SECTION — blue box
    block(
      fill: rgb("#003366"),
      inset: 4pt,
      text(fill: white, it)
    )
  }
}

// ── Outline entry styling ───────────────────────────────────────────────

#show outline.entry.where(level: 1): it => {
  v(0.4em)
  text(weight: "bold", it)
}

// ── Page de garde ─────────────────────────────────────────────────────────

#align(center)[
  #v(4cm)
  #text(size: 24pt, weight: "bold", fill: rgb("#003366"))[Reverse Engineering du\ Mayhem Bot]

  #v(1cm)
  #text(size: 12pt)[Analyse comportementale, modélisation mathématique\ et stratégies de trading sur Pump Fun / Solana]

  #v(2cm)
  #text(size: 10pt, style: "italic")[
    Nyrok \
    Février 2026
  ]

  #v(1cm)
  #text(size: 8pt, fill: gray.darken(30%))[
    Projet Meyham \
    1 184 trades analysés · 25 live runs · 5 stratégies testées
  ]
]

#pagebreak()

// ── Table des matières ────────────────────────────────────────────────────

#outline(title: "Table des matières", indent: 1.5em, depth: 3)

#pagebreak()

// ═════════════════════════════════════════════════════════════════════════
//  PARTIE I — ANALYSE
// ═════════════════════════════════════════════════════════════════════════

#heading(numbering: none, level: 1)[Partie I — Analyse]

#align(center, text(size: 8pt, fill: gray.darken(30%))[Reverse engineering, décodage on-chain et modélisation mathématique])
#v(0.3cm)

= Reverse engineering on-chain

== Analyse du smart contract

Le programme Mayhem a été analysé via son bytecode déployé on-chain et les logs de ses transactions. L'hypothèse initiale était que la logique du bot était *entièrement on-chain* : le volume de code déployé (gestion de sessions, compteurs cumulatifs, configuration globale, états par token) suggérait un système autonome capable de prendre ses propres décisions de trading directement sur la blockchain.

L'analyse du smart contract a infirmé cette hypothèse. Le programme est *purement exécutif* :

- Le programme expose des *instruction handlers* pour les opérations buy et sell, ainsi que des instructions d'initialisation de session et de configuration globale.
- *Aucune logique décisionnelle* n'est présente on-chain : le programme ne décide ni la direction du trade (buy/sell), ni le montant, ni le timing. Ces décisions sont prises *off-chain* par le backend du bot.
- Le programme se contente de *valider les contraintes* (slippage, hard caps, montants minimum) et d'*exécuter* les trades contre la bonding curve Pump Fun.
- Les paramètres de configuration (slippage tolerance, hard caps, session timeout) sont stockés dans un compte `GlobalState` modifiable uniquement par l'autorité du programme.

L'utilisation de *Jito* (bundle service pour transactions prioritaires sur Solana) par le bot a confirmé définitivement l'architecture off-chain. Un programme purement on-chain n'a pas besoin de Jito — les transactions seraient soumises directement par le runtime. Le recours à Jito implique un *backend off-chain* qui construit les transactions, choisit la direction et le montant, puis les soumet via Jito pour garantir leur inclusion rapide et ordonnée dans un bloc.

#figure(
fletcher.diagram(
  node-stroke: 0.8pt + rgb("#003366"),
  node-fill: luma(245),
  node-inset: 5pt,
  spacing: (14mm, 5mm),

  node((-1.5, 0), [*Bot backend*\ (off-chain)], shape: fletcher.shapes.rect, name: <bot>, fill: rgb("#E8F0FE")),
  node((1.5, 0), [*Programme Mayhem*\ (on-chain)], shape: fletcher.shapes.rect, name: <prog>),
  node((1.5, 1.5), [Validation\ slippage, caps,\ montants], shape: fletcher.shapes.rect, name: <valid>),
  node((1.5, 3), [Exécution\ buy/sell sur\ Pump Fun AMM], shape: fletcher.shapes.rect, name: <exec>),
  node((-1.5, 3), [*Bonding Curve*\ Pump Fun], shape: fletcher.shapes.rect, name: <curve>),

  edge(<bot>, <prog>, "->", label: [instruction\ buy/sell]),
  edge(<prog>, <valid>, "->"),
  edge(<valid>, <exec>, "->", label: [OK]),
  edge(<exec>, <curve>, "->", label: [CPI]),
),
caption: [Architecture : décision off-chain, soumission via Jito, exécution on-chain],
) <onchain-arch>

Cette découverte est fondamentale : *il est impossible de prédire le comportement du bot depuis le smart contract*. La seule voie est l'observation empirique des transactions on-chain pour inférer les règles comportementales du backend.

=== Instructions du programme

Le programme expose 20 instructions, réparties en trois catégories :

#figure(
  table(
    columns: (auto, 1fr),
    align: (left, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Instruction*], [*Description*]),
    [`Buy`], [Achat de tokens via la bonding curve Pump Fun],
    [`Sell`], [Vente de tokens via la bonding curve Pump Fun],
    [`BuyPumpSwap`], [Achat post-migration via le contrat Pump AMM],
    [`SellPumpSwap`], [Vente post-migration via le contrat Pump AMM],
    [`InitializeMayhemState`], [Crée le compte `TokenState` pour un nouveau token],
    [`ResetState`], [Réinitialise l'état d'une session],
    [`ResetSolDeployed`], [Remet à zéro le compteur de SOL déployé],
    [`ResumeTrading`], [Reprend le trading globalement après un arrêt],
    [`StopTrading`], [Arrête le trading globalement sur le programme],
    [`InitializeGlobalParams`], [Initialise la configuration globale],
    [`UpdateGlobalParams`], [Met à jour les paramètres globaux],
    [`InitializeFeeRecipient`], [Configure le destinataire des frais],
    [`UpdateTrader`], [Modifie le wallet de trading autorisé],
    [`UpdateAdmin`], [Transfère l'autorité d'administration],
    [`SweepFees`], [Collecte les frais accumulés],
    [`SweepFeesAdmin`], [Collecte les frais (mode admin)],
    [`UpdateMaxSolPerSweep`], [Modifie le plafond de sweep],
    [`WithdrawAdmin`], [Retrait administratif de fonds],
    [`BurnTokens`], [Brûle des tokens restants],
    [`ExtendAccount`], [Étend la taille d'un compte],
  ),
  caption: [Instructions du programme Mayhem],
) <instructions>

Les instructions `*PumpSwap` sont les variantes post-migration : lorsqu'un token atteint le seuil de liquidité et migre de la bonding curve vers le contrat *Pump AMM* (pool de liquidité classique), le bot continue de trader via ces instructions dédiées.

Le contrat Pump Fun expose également une instruction `updateMayhemVirtualParams` qui permet de modifier les réserves virtuelles de la bonding curve pour les tokens en mode Mayhem. Cette instruction n'a pas été explorée en détail dans le cadre de ce projet.

=== Erreurs custom

Le programme définit 8 codes d'erreur custom :

#figure(
  table(
    columns: (auto, 1fr),
    align: (left, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Erreur*], [*Description*]),
    [`TradingPaused`], [Le trading est suspendu sur ce token (via `StopTrading`)],
    [`TradingActive`], [Opération impossible car le trading est encore actif],
    [`MathOverflow`], [Dépassement arithmétique dans le calcul AMM],
    [`SolReservesTooLow`], [Réserves SOL insuffisantes pour exécuter le trade — inclut le cas *Sell ZeroAmount*],
    [`MayhemModeEnded`], [La session Mayhem est terminée pour ce token],
    [`MayhemModeNotEnded`], [Opération requiert que la session soit terminée],
    [`OverallRiskExceeded`], [Exposition totale du bot dépasse le seuil de risque global],
    [`CoinRiskExceeded`], [Exposition sur un token individuel dépasse le seuil de risque],
  ),
  caption: [Erreurs custom du programme Mayhem],
) <errors>

Les erreurs `OverallRiskExceeded` et `CoinRiskExceeded` révèlent un système de gestion du risque intégré au programme : le bot ne peut pas dépasser certains seuils d'exposition, tant globalement que par token.

== Référentiel d'adresses

L'ensemble des adresses on-chain identifiées durant le reverse engineering :

#figure(
  table(
    columns: (auto, 1fr),
    align: (left, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Identifiant*], [*Adresse (Base58)*]),
    [Programme Pump Fun], [`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`],
    [Programme Mayhem], [`MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e`],
    [Wallet de trading], [`Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA`],
    [Token account], [`BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s`],
    [Global State], [`13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ`],
    [Event Authority], [`8FoNgzmjuSmiy86EPCWxvv1q7oJSu2WGA7wPymwki2LJ`],
    [User Volume Accumulator], [`FGFrX2q1iAjyAojjeyFDxXqdmvegjPpSWsrPmrJjeQ2f`],
    [Fee Recipient], [`GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS`],
  ),
  caption: [Adresses on-chain du système Mayhem],
) <addresses>

== Décodage on-chain

Le reverse engineering du programme Mayhem a produit 8 décodeurs couvrant l'intégralité des structures on-chain. Tous utilisent le système de codecs `@solana/kit` avec un discriminateur de 8 ou 16 bytes en préfixe.

=== MayhemTradeEvent (trade du bot)

Structure principale, émise à chaque trade du bot. Contient les réserves avant et après le trade, ainsi que les compteurs cumulatifs :

#figure(
  table(
    columns: (auto, auto, 1fr),
    align: (left, left, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Champ*], [*Type*], [*Description*]),
    [`actionType`], [`u8`], [0 = achat, 1 = vente],
    [`maker`], [`PublicKey`], [Wallet du trader],
    [`mint`], [`PublicKey`], [Adresse du token],
    [`solAmount`], [`u64`], [SOL échangés (lamports)],
    [`tokenAmount`], [`u64`], [Tokens échangés],
    [`XpreTradeVirtualSolReserves`], [`u64`], [Réserves virtuelles SOL _avant_ trade],
    [`XpreTradeVirtualTokenReserves`], [`u64`], [Réserves virtuelles token _avant_ trade],
    [`totalSolBought`], [`i128`], [SOL cumulatif acheté (signé)],
    [`totalTokensSold`], [`i128`], [Tokens cumulatifs vendus (signé)],
    [`virtualSolReserves`], [`u64`], [Réserves virtuelles SOL _après_ trade],
    [`virtualTokenReserves`], [`u64`], [Réserves virtuelles token _après_ trade],
    [`XpreTradeRealTokenReserves`], [`u64`], [Réserves réelles token _avant_ trade],
    [`tradeTime`], [`i64`], [Timestamp Unix du trade],
    [`endTime`], [`i64`], [Timestamp de fin de session],
    [`realSolReserves`], [`u64`], [Réserves réelles SOL _après_ trade],
    [`realTokenReserves`], [`u64`], [Réserves réelles token _après_ trade],
    [`version`], [`u32`], [Version du schéma],
  ),
  caption: [Structure `MayhemTradeEvent` complète (discriminateur 16 bytes)],
) <trade-event>

Les champs préfixés `X` (pre-trade) permettent de recalculer l'impact de chaque trade et de valider la cohérence des réserves. Les compteurs signés `totalSolBought` / `totalTokensSold` (i128) encodent le P\&L cumulatif du bot sur le token.

=== TokenState (état de session par token)

Stocke l'état cumulatif d'une session de trading pour un token donné. Ce compte est créé à l'initialisation de la session et mis à jour à chaque trade :

#figure(
  table(
    columns: (auto, auto, 1fr),
    align: (left, left, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Champ*], [*Type*], [*Description*]),
    [`startTime`], [`u64`], [Début de la session],
    [`endTime`], [`u64`], [Fin de la session],
    [`targetMint`], [`PublicKey`], [Token ciblé],
    [`totalSolsBought`], [`i64`], [SOL total acheté (signé)],
    [`totalTokensSold`], [`i64`], [Tokens total vendus (signé)],
    [`lastUpdate`], [`u64`], [Dernier timestamp de mise à jour],
    [`isRunning`], [`bool`], [Session encore active],
  ),
  caption: [Structure `TokenState` (discriminateur 8 bytes)],
) <token-state>

Le flag `isRunning` est crucial pour le backtesting : il permet de détecter la fin de session et de déclencher la vente forcée des positions restantes.

=== GlobalState (configuration globale du programme)

Paramètres de configuration et limites du programme Mayhem. Ce compte est unique et contrôlé par l'autorité du programme :

#figure(
  table(
    columns: (auto, auto, 1fr),
    align: (left, left, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Champ*], [*Type*], [*Description*]),
    [`slippageBps`], [`u64`], [Tolérance de slippage (basis points)],
    [`hardCapBuySol`], [`u64`], [SOL max par achat],
    [`hardCapSellSol`], [`u64`], [SOL max par vente],
    [`solHoldingMin`], [`u64`], [SOL minimum à conserver],
    [`sweepThreshold`], [`u64`], [Seuil de sweep],
    [`adminFeeReceiver`], [`PublicKey`], [Destinataire des frais],
    [`programAuthority`], [`PublicKey`], [Autorité du programme],
    [`minTotalHolding`], [`u32`], [Holdings minimum totales],
    [`sessionTimeout`], [`u64`], [Durée timeout de session],
    [`version`], [`u32`], [Version du schéma],
    [`maxSession`], [`i32`], [Sessions concurrentes max],
  ),
  caption: [Structure `GlobalState` (discriminateur 8 bytes)],
) <global-state>

Les champs `hardCapBuySol` et `hardCapSellSol` confirment on-chain le cap à 20 SOL observé empiriquement. Le `sessionTimeout` définit la durée maximale d'une session de trading.

=== Décodeurs complémentaires

#figure(
  table(
    columns: (auto, 1fr),
    align: (left, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Décodeur*], [*Description*]),
    [`CreateV2`], [Instruction de création de token : `name`, `symbol`, `uri`, `creator`, `isMayhemMode`. Permet de détecter les tokens Mayhem à la création.],
    [`TradeEvent`], [Événement de trade standard Pump Fun (22 champs) : inclut les frais détaillés (`fee`, `creatorFee`, `feeBasisPoints`), le volume (`currentSolVolume`), et le flag `mayhemMode`.],
    [`MayhemIxData`], [Données d'instruction Mayhem : le discriminateur distingue buy (`66063d12`) et sell (`33e685a4`). Contient `marketCap` et `maxPriceImpact` (bps).],
    [`MayhemVirtualParamsEvent`], [Événement de changement de réserves virtuelles : contient les réserves avant/après (`newVirtualTokenReserves`, `newVirtualSolReserves`) pour analyser les ajustements AMM.],
  ),
  caption: [Décodeurs complémentaires],
) <other-decoders>

#pagebreak()

= Mécanique du bot Mayhem

== Cycle de vie d'une session

Une session de trading Mayhem suit un cycle de vie strict, observé empiriquement sur des centaines de tokens :

+ *Condition de lancement* : le bot ne démarre *pas* tant que $R_s >= 0.05 "SOL"$ (`realSolReserves`). Sans ce seuil minimum de liquidité dans le pool, aucune session n'est initialisée. Ce comportement est cohérent avec le champ `solHoldingMin` du `GlobalState`, qui impose un minimum de SOL réel avant activation.

+ *Initialisation* : une fois le seuil atteint, le bot crée un compte `TokenState` avec `isRunning = true`, enregistre `startTime`, et commence à trader.

+ *Phase de trading* : le bot exécute jusqu'à 50 trades en séquence pseudo-aléatoire (direction buy/sell approximativement 50/50). Chaque trade suit la règle des 20% du pool avec un cap à 20 SOL.

+ *Terminaison normale* : après 50 trades ou à l'expiration du `sessionTimeout`, le `endTime` est renseigné et `isRunning` passe à `false`. La session est terminée.

+ *Terminaison par erreur — Sell ZeroAmount* : si le pool est vidé de son SOL (tous les participants vendent massivement), le bot rencontre l'erreur Pump Fun *"Sell ZeroAmount"* lorsqu'il tente une vente. L'instruction échoue car `realSolReserves ≈ 0` — il n'y a plus de SOL à extraire du pool. Cette erreur met fin prématurément à la session.

#figure(
fletcher.diagram(
  node-stroke: 0.8pt + rgb("#003366"),
  node-fill: luma(245),
  node-inset: 5pt,
  spacing: (12mm, 5mm),

  node((0, 0), [Token créé\ (Pump Fun)], shape: fletcher.shapes.rect, name: <create>),
  node((0, 1.3), [$R_s >= 0.05$ SOL ?], shape: fletcher.shapes.diamond, name: <threshold>),
  node((1.8, 1.3), [Pas de session\ Mayhem], shape: fletcher.shapes.rect, name: <nosess>, fill: rgb("#FFEEEE")),
  node((0, 2.8), [Session initialisée\ `isRunning = true`], shape: fletcher.shapes.rect, name: <init>),
  node((0, 4.2), [Trading\ (50 trades max)], shape: fletcher.shapes.rect, name: <trading>),
  node((-1.5, 5.8), [50 trades ou\ timeout], shape: fletcher.shapes.rect, name: <normal>),
  node((1.5, 5.8), [Sell ZeroAmount\ ($R_s approx 0$)], shape: fletcher.shapes.rect, name: <error>, fill: rgb("#FFEEEE")),
  node((0, 7), [Session terminée\ `isRunning = false`], shape: fletcher.shapes.rect, name: <end>),

  edge(<create>, <threshold>, "->"),
  edge(<threshold>, <nosess>, "->", label: [non]),
  edge(<threshold>, <init>, "->", label: [oui]),
  edge(<init>, <trading>, "->"),
  edge(<trading>, <normal>, "->", corner: left),
  edge(<trading>, <error>, "->", corner: right),
  edge(<normal>, <end>, "->", corner: right),
  edge(<error>, <end>, "->", corner: left),
),
caption: [Cycle de vie d'une session Mayhem],
) <session-lifecycle>

== Comportement observé

L'analyse de centaines de sessions révèle un comportement régulier :

#figure(
  table(
    columns: (auto, 1fr),
    align: (left, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Paramètre*], [*Valeur observée*]),
    [Direction], [50/50 aléatoire (buy/sell)],
    [Montant (buy)], [$min("realSolReserves" times 20%, 20 "SOL")$],
    [Montant (sell)], [$min("realSolReserves" times 20% - 1, 20 "SOL")$],
    [Trades max], [50 par session],
    [Seuil d'activation], [$R_s >= 0.05$ SOL (realSolReserves)],
    [Durée typique], [30–120 secondes],
  ),
  caption: [Paramètres comportementaux du bot Mayhem],
) <bot-params>

Le montant de chaque trade est proportionnel à la taille du pool : au début de la session ($R_s < 0.1$ SOL), chaque trade ne représente que quelques millièmes de SOL. À mesure que le pool croît (via les achats), les trades deviennent plus importants. Le cap à 20 SOL empêche les trades excessifs sur les pools profonds.

== Montants des trades du bot

La règle des 20% crée une croissance exponentielle de la taille des trades au fil des achats successifs :

#figure(
  image("figures/08_bot_trade_amounts.png", width: 100%),
  caption: [Montant des trades du bot : règle $min(R_s times 20%, 20 "SOL")$],
) <bot-amounts>

Le graphique montre qu'après ~30 achats consécutifs, le montant par trade atteint le cap de 20 SOL et se stabilise. En pratique, la séquence aléatoire buy/sell fait osciller le montant des trades autour d'un équilibre.

== Tests d'indépendance de la séquence buy/sell

L'affirmation « direction 50/50 aléatoire » du tableau @bot-params a été vérifiée formellement en décomposant la question « la séquence est-elle i.i.d. 50/50 ? » en trois sous-questions orthogonales, chacune avec son test dédié (`tools/independenceTests.py`). Un point méthodologique essentiel : les trades ne forment pas une séquence continue mais *44 sessions indépendantes* (2 045 trades, sessions $>= 20$ trades). Chaque statistique est donc calculée *par session* puis agrégée — concaténer les sessions introduirait des transitions inter-sessions sans signification (le générateur est vraisemblablement réinitialisé à chaque token).

=== Test 1 — Marginale (binomial)

$H_0 : p = 0.5$. Sur 2 045 trades : 1 060 buys, soit *51,83 %* (erreur-type 1,11 pp), $p = 0.10$. Non significatif. Par session : 1/44 significative à 5 % (attendu sous $H_0$ : ~2,2).

=== Test 2 — Indépendance sérielle (runs test de Wald-Wolfowitz)

Pour chaque session, le nombre de runs $R$ (séquences maximales de même direction) est comparé à sa loi sous l'hypothèse aléatoire : $mu = (2 n_1 n_2) / (n_1 + n_2) + 1$, $Z = (R - mu) \/ sigma approx cal(N)(0,1)$. Un $Z$ très négatif signalerait des streaks (clustering), un $Z$ très positif une sur-alternance — deux structures directement exploitables.

#figure(
  table(
    columns: (1fr, auto),
    align: (left, right),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Statistique agrégée (44 sessions)*], [*Valeur*]),
    [Moyenne des $Z$ de session], [$-0.03$],
    [Écart-type des $Z$ (attendu : 1)], [$0.96$],
    [Sessions significatives $|Z| > 1.96$ (attendu : ~2,2)], [1 / 44],
    [Kolmogorov-Smirnov des $Z$ vs $cal(N)(0,1)$], [$D = 0.095$, $p = 0.79$],
    [Stouffer combiné], [$Z = -0.21$, $p = 0.83$],
  ),
  caption: [Runs test par session, agrégation sur 44 sessions],
) <runs-test>

La distribution empirique des $Z$ de session est indiscernable d'une $cal(N)(0,1)$ : ni streaks, ni sur-alternance. L'autocorrélation moyenne (lags 1–5) est partout $|r| < 0.05$ ; seul le lag 3 atteint $z = -2.16$, attendu par hasard sur 5 lags testés (comparaisons multiples).

=== Test 3 — Structure d'ordre supérieur (Markov)

Table de transition d'ordre 1 (poolée intra-session) : $P("buy" | "buy") = 0.523$ contre $P("buy" | "sell") = 0.514$ — écart de $+0.9$ pp, $chi^2 = 0.17$, $p = 0.68$. Le test du rapport de vraisemblance entre ordres confirme l'absence de mémoire : ordre 0 vs 1, $G^2 = 0.17$ ($p = 0.68$) ; ordre 1 vs 2, $G^2 = 0.39$ ($p = 0.83$). Les quatre conditionnelles d'ordre 2 sont toutes dans $[0.504, 0.529]$, à moins d'une erreur-type de la marginale.

=== Conclusion : aucune structure exploitable

#figure(
  table(
    columns: (auto, auto, 1fr),
    align: (left, right, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Signal*], [*Taille d'effet*], [*Verdict vs ~2 % de frais aller-retour*]),
    [Biais marginal], [1,83 pp], [Non significatif, et inexploitable même si réel],
    [Edge ordre 1], [0,46 pp], [Très en dessous du seuil de rentabilité],
    [Runs / streaks], [$Z$ moyen $-0.03$], [Aucun signal],
  ),
  caption: [Significativité vs exploitabilité],
) <independence-verdict>

La séquence *réalisée* est statistiquement indiscernable d'un tirage i.i.d. équilibré : la direction du prochain trade du bot n'est pas prédictible à partir de l'historique des directions. Ces tests ne couvrent toutefois que la séquence observée — un PRNG faible avec un seed devinable y serait invisible et resterait la seule voie de prédiction restante. Conséquence stratégique : tout edge doit venir de la *mécanique* du bot (règle des 20 %, asymétrie d'impact AMM, cycle de session) et non de la prédiction directionnelle.

#pagebreak()

// ═════════════════════════════════════════════════════════════════════════
//  PARTIE II — STRATÉGIE
// ═════════════════════════════════════════════════════════════════════════

#heading(numbering: none, level: 1)[Partie II — Stratégie]

#align(center, text(size: 8pt, fill: gray.darken(30%))[Simulations Monte Carlo, stratégies testées et résultats live])
#v(0.3cm)

= Stratégies Monte Carlo (simulation pure)

== Sept stratégies de base

Avant de passer au mainnet, 7 stratégies ont été testées en simulation Monte Carlo (10 000+ simulations par stratégie, bot 50/50 aléatoire, 50 trades par session) :

#figure(
  table(
    columns: (auto, 1fr, auto, auto),
    align: (left, left, right, right),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Stratégie*], [*Logique*], [*WR (%)*], [*Mean P\&L*]),
    [`buyAndHold`], [Achète au trade 1, vend à la fin], [~48], [-1.5%],
    [`followMomentum`], [Copie la direction du bot], [~45], [-2.1%],
    [`contrarian`], [Fait l'inverse du bot], [~46], [-1.8%],
    [`threshold`], [Achète si prix < -5%, vend si > +5%], [~44], [-2.3%],
    [`dca`], [Achète tous les 5 trades], [~47], [-1.6%],
    [`quickFlip`], [Achète puis vend immédiatement], [~42], [-2.0%],
    [`streakReversal`], [Inverse après N trades consécutifs], [~45], [-1.9%],
  ),
  caption: [Résultats Monte Carlo des 7 stratégies de base],
) <mc-strategies>

== Conclusion des simulations

*Aucune stratégie simple n'est rentable en simulation pure.* Le frais de 1% par trade (soit ~2% aller-retour) détruit systématiquement l'edge.

De plus, l'impact des ventes du bot est structurellement plus pénalisant que celui des achats. Sur une courbe à produit constant, une vente de 20% de $R_s$ retire du SOL du pool et fait chuter le prix davantage qu'un achat de 20% de $R_s$ ne le fait monter. Cette asymétrie d'impact est inhérente à la formule AMM : retirer de la liquidité a un effet plus violent qu'en ajouter pour un même montant relatif. En conséquence, une séquence 50/50 buy/sell n'est pas neutre — elle a une dérive baissière naturelle.

La seule voie vers la rentabilité est d'exploiter la *structure temporelle* des trades du bot sur le mainnet réel (phases, séquences, timing), chose que la simulation 50/50 pure ne capture pas.

#pagebreak()

= dipAccumulator TP=5 — Meilleure stratégie

== Logique

Le `dipAccumulator` achète à chaque vente du bot (accumulation sur les dips) et vend tout dès que le take profit est atteint :

#figure(
fletcher.diagram(
  node-stroke: 0.8pt + rgb("#003366"),
  node-fill: luma(245),
  node-inset: 5pt,
  spacing: (12mm, 5mm),

  node((0, 0), [*Début*\ (budget = 1 SOL)], shape: fletcher.shapes.rect, name: <start>),
  node((0, 1.3), [Bot trade\ reçu], shape: fletcher.shapes.diamond, name: <trade>),
  node((-1.5, 2.5), [Bot SELL\ → Acheter 0.1 SOL], shape: fletcher.shapes.rect, name: <buy>),
  node((1.5, 2.5), [Bot BUY\ → Attendre], shape: fletcher.shapes.rect, name: <wait>),
  node((0, 4), [Vérifier P\&L], shape: fletcher.shapes.diamond, name: <check>),
  node((-1.8, 5.5), [P\&L $>= +5%$\ → *SELL (TP)*], shape: fletcher.shapes.rect, name: <tp>),
  node((0, 5.5), [P\&L $<= -20%$\ → *SELL (SL)*], shape: fletcher.shapes.rect, name: <sl>),
  node((1.8, 5.5), [Sinon\ → Continuer], shape: fletcher.shapes.rect, name: <cont>),
  node((0, 7), [*Fin*\ (résultat JSONL)], shape: fletcher.shapes.rect, name: <end>),

  edge(<start>, <trade>, "->"),
  edge(<trade>, <buy>, "->", label: [sell], corner: left),
  edge(<trade>, <wait>, "->", label: [buy], corner: right),
  edge(<buy>, <check>, "->", corner: right),
  edge(<wait>, <check>, "->", corner: left),
  edge(<check>, <tp>, "->", label: [$>= 5%$], corner: left),
  edge(<check>, <sl>, "->", label: [$<= -20%$]),
  edge(<check>, <cont>, "->", label: [else], corner: right),
  edge(<cont>, <trade>, "->", bend: 40deg),
  edge(<tp>, <end>, "->", corner: right),
  edge(<sl>, <end>, "->"),
),
caption: [Flowchart du dipAccumulator],
) <dipaccum-flow>

== Configuration optimale

#figure(
  table(
    columns: (auto, auto, 1fr),
    align: (left, right, left),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Paramètre*], [*Valeur*], [*Description*]),
    [`budget`], [1 SOL], [Capital par token],
    [`tradeSize`], [0.1 SOL], [Montant par achat],
    [`takeProfit`], [5%], [Seuil de sortie en profit],
    [`stopLoss`], [20%], [Seuil de sortie en perte],
    [`maxBuys`], [10], [Maximum d'achats par session],
    [`sellStreak`], [1], [Ventes consécutives avant achat],
  ),
  caption: [Configuration optimale du dipAccumulator],
) <dipaccum-config>

== Résultats live

#figure(
  image("figures/03_dipaccum_wallet.png", width: 100%),
  caption: [Wallet curve du dipAccumulator sur le mainnet],
) <dipaccum-wallet>

== Analyse : TP overshoot et asymétrie

Le succès du dipAccumulator repose sur une asymétrie favorable :

- *TP overshoot* : le seuil est à +5%, mais l'exit réel moyen est à +6.5% (le prix continue de monter entre le check et la vente).
- *Vitesse d'exécution* : les winners sortent vite (2-3 achats, 6-10 secondes). Les losers accumulent plus de trades (6-8 achats).
- *Win Rate live* : 67-75% (bien au-dessus du breakeven théorique de ~77% grâce au TP overshoot).

== Distribution P&L

#figure(
  image("figures/02_dipaccum_pnl_dist.png", width: 100%),
  caption: [Distribution des P\&L du dipAccumulator (toutes runs)],
) <dipaccum-pnl>

La distribution montre un pic prononcé entre +5% et +10% (TP overshoot) et une queue gauche étalée jusqu'à -30% (SL overshoot).

#pagebreak()

= flipScalper v2 — Stratégie asymétrique

== Architecture : subscription persistante

Le flipScalper utilise une architecture fondamentalement différente : une *subscription WebSocket persistante* qui survit entre les tokens. Cela élimine la race condition d'initialisation et permet de capturer le premier trade de chaque nouveau token.

#figure(
fletcher.diagram(
  node-stroke: 0.8pt + rgb("#003366"),
  node-fill: luma(245),
  node-inset: 5pt,
  spacing: (12mm, 5mm),

  node((0, 0), [*onLogs persistant*\ (wallet bot)], shape: fletcher.shapes.rect, name: <sub>),
  node((0, 1.2), [Nouveau mint\ détecté], shape: fletcher.shapes.diamond, name: <new>),
  node((0, 2.5), [Achat initial\ 0.2 SOL\ (courbe défaut)], shape: fletcher.shapes.rect, name: <init>),
  node((0, 3.8), [Bot trade\ reçu], shape: fletcher.shapes.diamond, name: <trade>),
  node((-1.5, 5.2), [Bot SELL →\ FLIP BUY\ (0.2 SOL)], shape: fletcher.shapes.rect, name: <fbuy>),
  node((1.5, 5.2), [Bot SELL →\ FLIP SELL\ (tokens flip)], shape: fletcher.shapes.rect, name: <fsell>),
  node((0, 6.8), [Vérifier\ MCAP < 30 ?], shape: fletcher.shapes.diamond, name: <mcap>),
  node((0, 8.2), [*Exit*\ (MCAP30 / END)], shape: fletcher.shapes.rect, name: <exit>),

  edge(<sub>, <new>, "->"),
  edge(<new>, <init>, "->"),
  edge(<init>, <trade>, "->"),
  edge(<trade>, <fbuy>, "->", label: [alternance], corner: left),
  edge(<trade>, <fsell>, "->", label: [alternance], corner: right),
  edge(<fbuy>, <mcap>, "->", corner: right),
  edge(<fsell>, <mcap>, "->", corner: left),
  edge(<mcap>, <exit>, "->", label: [oui]),
  edge(<mcap>, <trade>, "->", label: [non], bend: 40deg),
),
caption: [Architecture du flipScalper v2],
) <flipscalper-flow>

== Logique : initial buy + flip cycle + MCAP floor

+ *Achat initial* : dès qu'un nouveau mint est détecté, achat de 0.2 SOL aux réserves par défaut de la bonding curve (avant tout trade bot). Le MCAP initial est ~28 SOL.
+ *Cycle flip* : à chaque vente du bot, le joueur alterne entre FLIP BUY et FLIP SELL. La position initiale est maintenue tout au long.
+ *MCAP floor* : si le market cap tombe sous 30 SOL (après avoir dépassé 30), vente forcée de toute la position. Le flag `mcapPeaked` empêche les faux triggers au démarrage.

== Résultats live (run8, 109 tokens)

#figure(
  image("figures/05_flipscalper_wallet.png", width: 100%),
  caption: [Wallet curve du flipScalper (run8)],
) <flipscalper-wallet>

== Distribution P&L et dépendance fat-tail

#figure(
  image("figures/04_flipscalper_pnl_dist.png", width: 100%),
  caption: [Distribution P\&L du flipScalper — dépendance aux fat tails],
) <flipscalper-pnl>

Le flipScalper est *fat-tail dépendant* : la majorité des tokens sont des petites pertes (-5% à -15%), mais quelques gros winners (+50% à +195%) compensent largement. La stratégie serait non-rentable sans ces événements rares.

#pagebreak()

= Stratégies échouées

== smartDipAccumulator — Trailing stop overshoot

Le `smartDipAccumulator` ajoutait un trailing stop et des filtres d'entrée au `dipAccumulator`. Résultat offline : 85% WR, wallet ×2.5. Résultat live : ~45% WR, wallet en baisse.

#figure(
fletcher.diagram(
  node-stroke: 0.8pt + rgb("#003366"),
  node-fill: luma(245),
  node-inset: 5pt,
  spacing: (14mm, 6mm),

  node((0, 0), [P\&L peak\ = *+6.2%*], shape: fletcher.shapes.rect, name: <peak>),
  node((0, 1.3), [Trail activé\ $"dynSL" = +3.26%$], shape: fletcher.shapes.rect, name: <trail>),
  node((0, 2.8), [GAP\ (pas de trades\ intermédiaires)], shape: fletcher.shapes.rect, name: <gap>, fill: rgb("#FFEEEE")),
  node((0, 4.3), [Exit réel\ = *-2.43%*], shape: fletcher.shapes.rect, name: <exit>, fill: rgb("#FFDDDD")),

  edge(<peak>, <trail>, "->"),
  edge(<trail>, <gap>, "->", label: [P\&L chute\ en un seul trade]),
  edge(<gap>, <exit>, "->"),
),
caption: [Trailing stop overshoot : le P\&L traverse le seuil entre deux trades discrets],
) <trail-overshoot>

*Cause racine* : entre deux trades discrets du bot, le P\&L peut chuter de +6% à -2% en un seul pas. Le trailing stop à +3.26% n'est jamais atteint — il est directement traversé. Résultat : des winners garantis (+5%) deviennent des losers (-2%).

== proportionalDip — Amplification des pertes

Le `proportionalDip` ajustait le montant d'achat proportionnellement aux réserves du pool :

$
"buyAmount" = "tradeSize" times "clamp"(R_s / "scaleThreshold", "minScale", "maxScale")
$

Résultat live : 36% WR, wallet 0.50 SOL (-50%). Le problème : les tokens qui pompent reçoivent des achats plus gros (pool profond), puis quand ils dump, la position amplifiée subit une perte proportionnellement plus grande.

== momentumConfirmed A/C — Kill switch

Stratégie basée sur un score de momentum (ratio achats/ventes récentes). Le kill switch (sortie forcée si P\&L < -2% après N trades) était trop conservateur : il éjectait la majorité des positions avant qu'elles aient le temps de performer. 28 tokens testés, 28.6% WR.

#pagebreak()

= Résumé synthétique

== Résultats clés

Le reverse engineering du bot Mayhem a permis de décoder intégralement son comportement on-chain et de développer deux stratégies profitables sur le mainnet Solana :

#figure(
  table(
    columns: (auto, auto, auto, auto, auto),
    align: (left, right, right, right, right),
    stroke: 0.5pt + rgb("#003366"),
    table.header([*Stratégie*], [*Tokens*], [*Win Rate*], [*P\&L total*], [*Wallet final*]),
    [dipAccumulator TP=5], [200+], [67–75%], [+0.49 SOL/run], [1.0 → 1.49],
    [flipScalper v2], [109], [~36%], [+0.67 SOL/run], [1.0 → 1.67],
    [smartDipAccumulator], [30], [~45%], [négatif], [en baisse],
    [proportionalDip], [28], [~36%], [-0.50 SOL], [1.0 → 0.50],
    [momentumConfirmed], [28], [~29%], [négatif], [en baisse],
  ),
  caption: [Synthèse des résultats par stratégie],
) <summary-table>

== Biais offline vs live

#figure(
  image("figures/06_offline_vs_live_wr.png", width: 100%),
  caption: [Win Rate offline vs live — le biais des datasets est massif],
) <offline-live>

Les datasets offline sont biaisés vers des tokens « intéressants » (volatils, avec patterns notables). En live, les tokens aléatoires pompent plus souvent qu'attendu. Le dipAccumulator passe de 46% WR offline à 75% live, tandis que le smartDipAccumulator chute de 85% à 45%.

== Raisons de sortie

#figure(
  image("figures/07_exit_reasons.png", width: 100%),
  caption: [Répartition des raisons de sortie par stratégie],
) <exit-reasons>

== Conclusions

Le bot Mayhem est un *market maker pseudo-aléatoire* dont le smart contract est purement exécutif et le comportement est entièrement piloté off-chain via Jito. Son cycle de vie (activation à $R_s >= 0.05$ SOL, 50 trades, terminaison par timeout ou erreur Sell ZeroAmount) crée des fenêtres d'opportunité exploitables.

*Aucune stratégie n'a permis d'être rentable en toutes circonstances.* Le dipAccumulator et le flipScalper affichent des résultats positifs sur certaines runs, mais leur rentabilité dépend fortement des conditions de marché et de la distribution des tokens rencontrés. Une run favorable (majorité de tokens qui pompent) génère des profits, tandis qu'une séquence défavorable peut effacer les gains accumulés. La nature pseudo-aléatoire du bot rend toute garantie de rentabilité impossible.

Les observations clés sont :
+ *Simplicité* : les stratégies simples (dipAccumulator) surperforment les stratégies complexes (smartDipAccumulator, proportionalDip) en conditions live.
+ *Asymétrie* : le TP overshoot favorable (+1.5% en moyenne) compense partiellement le SL overshoot défavorable, mais ne suffit pas à garantir un edge constant.
+ *Biais de validation* : le backtesting offline est nécessaire mais insuffisant, avec un biais de dataset pouvant inverser les conclusions. La validation sur le mainnet est indispensable.
