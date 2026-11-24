# Control Tower

Et lokalt kontroltårn til dine kodeagenter. Det viser alle git-repos i én mappe, deres status og deres "hjerne" (docs-mappen), og du kan åbne en terminal eller starte en agent direkte i et repo og følge dens status. Du kan også læse issues og reviews på pull requests og sende dem til en kørende agent, og se dine skills.

Alt kører på din egen maskine. Der sendes ikke noget til andre end de tjenester, du selv bruger i terminalen (fx GitHub via `gh`).

## Kom i gang

Kræver Node.js 20 eller nyere og git. Pull requests kræver desuden [GitHub CLI](https://cli.github.com) (`gh auth login`).

```bash
npm install
npm start -- "/sti/til/din/projektmappe"   # første gang
npm start                                  # derefter
```

Programmet åbner selv din browser. Linket i terminalen indeholder en nøgle, som kun gælder indtil du stopper programmet med Ctrl+C. Starter du igen, får du et nyt link – en åben fane viser så "Control Tower er låst", indtil du åbner det nye.

`npm start -- --help` viser tilvalgene. `--no-open` starter uden at åbne browseren.

## Start uden VS Code (Windows og Mac)

Du behøver ikke have VS Code eller en terminal åben for at bruge Control Tower. Kør én gang for at oprette genvej/app:

```bash
npm run shortcut
```

- **Windows**: Opretter en **Control Tower**-genvej på Skrivebordet og i Start-menuen (du kan også dobbeltklikke på `Opret genvej (Windows).cmd` eller starte direkte med `Start Control Tower.vbs`). Control Tower kører stille i systembakken ved uret:
  - Venstreklik på ikonet for at åbne browseren (dobbeltklik på genvejen igen gør det samme).
  - Højreklik på ikonet for at kopiere link, se log, redigere indstillinger, genstarte, slå "Start automatisk med Windows" til/fra eller afslutte pænt.
- **Mac**: Opretter `~/Applications/Control Tower.app` og en genvej på Skrivebordet (du kan også dobbeltklikke på `Opret app (Mac).command`, eller køre `Start Control Tower.command` direkte). Start via Spotlight (`Cmd+Mellemrum` -> `Control Tower`) eller træk appen til Docken:
  - Klik på ikonet i Docken (eller Spotlight) for at genåbne browseren.
  - Brug `Cmd+Q` (eller højreklik i Docken -> Slut) for at stoppe Control Tower pænt.

## Indstillinger

Første start opretter `control-tower.config.json` (filen er ikke med i git). En eksisterende fil bliver aldrig overskrevet – kun `root` ændres, hvis du starter med en ny sti.

```json
{
  "root": "/Users/dig/Projects",
  "port": 4317,
  "brainPaths": ["docs", "CLAUDE.md", "AGENTS.md", ".claude"],
  "agents": [
    { "id": "claude", "name": "Claude Code", "command": "claude" },
    { "id": "gemini", "name": "Gemini", "command": "agy" },
    { "id": "mistral", "name": "Mistral", "command": "vibe" },
    { "id": "codex", "name": "OpenAI Codex", "command": "codex" }
  ],
  "idleSeconds": 8,
  "maxSessions": 12,
  "personalSkillsDirs": [
    "~/.claude/skills",
    "~/.gemini/skills",
    "~/.agents/skills"
  ]
}
```

- `agents` er listen over knapper i interfacet. Kun kommandoer på denne liste kan startes som agent. Claude Code (`claude`), Gemini (`agy`), Mistral Vibe (`vibe`) og OpenAI Codex (`codex`) er altid med, også i en ældre fil med sin egen liste. Har du en agent med samme id, bruges din. `"builtinAgents": false` slår de faste fra. Hver agent får et lille farvet mærke (C, G, M, O), så du kan se, hvilken model den kører på.
- `brainPaths` er de mapper og filer i hvert repo, der vises under "Hjerne" (kun .md, .mdx og .txt). Agenternes arbejdskopier (`.claude/worktrees` og andre mapper med deres egen `.git`) og `docs/reports` (som har sin egen fane) tælles ikke med.
- `idleSeconds` er hvor længe en agent skal være stille, før status skifter fra "Arbejder" til "Venter på dig".

## Overblikket

Øverst står altid det næste skridt: hvilken agent der venter på dig, eller at alt kører. Under "Arbejdspladser" har hver agent en figur ved et skrivebord: den skriver når den arbejder, rækker hånden op når den venter, og taleboblen viser den seneste linje fra agenten. Taleboblen er et skøn – agenter der tegner hele skærmen om, kan vise en bundlinje i stedet for en besked. "Start agent" på et repo-kort starter den første agent på din liste.

## Mission Control og Split-Screen

- **Mission Control (`#page=mission`)**: Punktet *Mission Control* i venstremenuen viser alle aktive agenter og terminaler på tværs af repos i et live multi-terminal grid, hvor du kan skrive direkte i hver terminal, godkende hurtig-svar (`Enter` / `y` / `Esc`) og skifte mellem 1 eller 2 kolonner.
- **Split-fane i et repo (`◫ Split`)**: Når et repo har 2 eller flere sessioner kørende, vises fanen *◫ Split (N)*, som samler repoets egne terminaler side om side.
- **Del skærm i en terminal (`◫ Del skærm`)**: Inde i enhver terminalvisning kan du i topbaren vælge en anden session til at åbne side om side (50/50 split), bytte sider (`⇄ Byt side`) eller maksimere den ene (`⤢ Kun denne`).

## Resumé af agentens arbejde

Når en agent venter eller er færdig, viser dens kort og terminalvisning et resumé: hvor længe den kørte, nye commits, og hvilke filer der er ændret siden start. Filer du selv havde ændret, før agenten startede, markeres. Resuméet bygger kun på git og kalder ingen model, så det viser alt der er ændret i repoet i perioden – også det du selv eller en anden agent har lavet imens. Knappen "Bed om resumé" indsætter et spørgsmål hos agenten, hvis du vil have dens egen forklaring i ord.

## Roller og rapporter

Fanen **Roller** i et repo starter en agent i en fast rolle: Fejlfinder, Security, QA-tester, UI/UX-ekspert, Issue/PO, Udvikler, Orkestrator eller Teknisk dokumentation. Du vælger hver gang, hvilken agent rollen skal køre i (Claude Code, Antigravity eller en anden fra din liste), og kan skrive et fokus eller en opgave med. Rollens arbejdsbeskrivelse indsættes hos agenten, så snart den er klar – du læser den og trykker Enter.

Rollerne er generiske: de finder selv ud af, hvordan repoet bygges og testes. Control Tower gætter teknologien (TypeScript/JavaScript, Kotlin/Android, Flutter/Dart) og giver rollen de tilhørende noter med fra `roles/stacks`.

- **Gennemgangs-rollerne** (Fejlfinder, Security, QA, UI/UX) ændrer ikke din kode. De skriver én rapport i `docs/reports/ÅÅÅÅ-MM-DD-<rolle>.md`.
- **Rapporter**-fanen viser rapporterne og deler dem op i fund. Hvert fund kan sendes til **Udvikler** (retter, tester, laver en PR og skriver en rapport tilbage) eller til **Issue/PO** (laver issues med acceptkriterie – viser dem først og opretter dem kun efter dit ja).
- **Orkestrator** tager flere issues, lægger en plan (rækkefølge, afhængigheder, loop-størrelse) og kører dem ét ad gangen gennem skillen `/dev-review-loop` med udvikler- og tester-subagenter – én PR pr. issue. Statustavlen ligger under Rapporter. Den merger aldrig selv.
- **Teknisk dokumentation** skriver release notes ud fra merged PR'er, retter forældede docs, flytter gennemførte planer til historik og laver en PR, så hjernen passer med koden.
- Rollerne ligger som markdown-filer i mappen `roles`. Ret dem som almindelig tekst.
- **Tillæg pr. repo:** læg en fil i repoet på `.control-tower/roles/<rolle>.md`, fx `security.md`, så kommer dens tekst med, når rollen startes i netop det repo. En fil med et nyt navn og egen frontmatter (`name`, `icon`, `description`) bliver en ny rolle, der kun findes i det repo.

At en rolle "ikke ændrer kode" er en instruks til agenten, ikke noget Control Tower kan håndhæve. Tjek resuméet efter kørslen.

## Issues

Fanen Issues viser repoets åbne GitHub-issues (via `gh`). Åbn et issue, og send det til en kørende agent. Har repoet en skill til issues, kan du vælge den – så sendes kun `/skill-navn nummer`, og agenten henter selv issuet. Uden skill sendes titel og beskrivelse. Valget huskes pr. repo i din browser. Control Tower ændrer ikke noget på GitHub.

## Skills

Fanen Skills i et repo viser repoets egne skills (`.claude/skills`, `.gemini/skills`, `.agents/skills` samt ældre `.claude/commands` / `.gemini/commands`) og dine personlige (`~/.claude/skills`, `~/.gemini/skills`, `~/.agents/skills`, inkl. dem der er synkroniseret fra claude.ai). Punktet Skills i menuen viser dem alle samlet. Har et repo og din personlige mappe en skill med samme navn, markeres repoets som overskygget.

Control Tower læser kun skills. En ny skill laves ved at udfylde formularen: beskrivelsen indsættes hos en kørende agent, som skriver filen, og du trykker selv Enter. Findes navnet allerede, bedes agenten forbedre den eksisterende i stedet for at overskrive den. Når du har flere personlige skill-mapper, kan du i formularen vælge, hvilken mappe en ny personlig skill skal gemmes i.

### Sådan tilføjer du ekstra skill-mapper (Windows og Mac)

Har du skills liggende i en eller flere egne mapper på tværs af projekter, kan du tilføje dem i `personalSkillsDirs` i `control-tower.config.json`:

```json
{
  "personalSkillsDirs": [
    "~/.claude/skills",
    "~/.gemini/skills",
    "~/.agents/skills",
    "~/mine-skills"
  ]
}
```

- `~/` udvides automatisk til din hjemmemappe på både **Mac** og **Windows**.
- Du kan også angive fulde stier:
  - **Mac**: `"/Users/dit-navn/mine-skills"`
  - **Windows**: `"C:\\Users\\dit-navn\\mine-skills"`
- Inde i hver mappe skal hver skill ligge i sin egen undermappe med en `SKILL.md`-fil:
  ```text
  mine-skills/
  ├── min-foerste-skill/
  │   └── SKILL.md
  └── min-anden-skill/
      └── SKILL.md
  ```
- Genstart Control Tower efter ændring af `control-tower.config.json`.

### Del en ekstra skill-mappe direkte med både Claude Code og Gemini (`agy`)

`personalSkillsDirs` gør, at Control Tower kan vise og bruge dine skills fra ekstra mapper. Vil du også have, at selve **Claude Code** og **Gemini (`agy`)** i terminalen automatisk indlæser skills fra en fælles mappe (fx `~/mine-skills`) uden at kopiere dem, kan du linke dem ind i agenternes standardmapper:

**Mac (Terminal):**
```bash
ln -s ~/mine-skills/* ~/.claude/skills/
ln -s ~/mine-skills/* ~/.gemini/skills/
```

**Windows (PowerShell):**
```powershell
Get-ChildItem "$HOME\mine-skills" -Directory | ForEach-Object {
  New-Item -ItemType Junction -Path "$HOME\.claude\skills\$($_.Name)" -Target $_.FullName -ErrorAction SilentlyContinue
  New-Item -ItemType Junction -Path "$HOME\.gemini\skills\$($_.Name)" -Target $_.FullName -ErrorAction SilentlyContinue
}
```

Control Tower frasorterer automatisk dubletter via filernes reelle sti (`realpath`), så hver skill kun vises én gang i oversigten, selvom den er linket ind i flere mapper.

## Token-regnskab

Punktet Regnskab i menuen (og token-tælleren i topbaren) samler forbruget opdelt i input, cache og output – både pr. agent, pr. projekt/repo, pr. model, pr. dag og samlet total.

Control Tower kombinerer sit eget sessionsregnskab (`control-tower.tokens.json`, der huskes på tværs af genstarter) med lokale logfiler fra Claude Code (`~/.claude/projects`) og Antigravity/Gemini (`~/.gemini/antigravity-cli/brain`), så også historik og kørsler startet uden for Control Tower tælles med uden dobbelttælling. Indstillingerne `tokensFile`, `claudeProjectsDir` og `agyBrainDir` kan ændres eller sættes til `false` i `control-tower.config.json`.

## Beskeder, lyd og fanens titel

Knapperne "Beskeder" og "Lyd" øverst er slået fra, indtil du selv slår dem til. Med beskeder til får du en notifikation fra browseren, når en agent venter på dig, går ned eller bliver færdig – medmindre du allerede kigger på netop den agent, eller selv har stoppet den. Lyden er to korte toner. Fanens titel viser altid antallet først og derefter en lille kommentar, fx "(1) Agenten tripper". Valgene huskes i din browser.

## Status

| Status | Betyder |
|---|---|
| Arbejder | Agenten skriver til terminalen lige nu |
| Venter på xxxx | Ingen ny tekst i `idleSeconds` sekunder, men der kører subagenter, tests, emulator, build m.m. |
| Venter på dig | Agenten venter på dit svar eller din godkendelse (også selv om der samtidig kører en baggrundsopgave) |
| Limit reached – venter på reset | Agenten har ramt sin kvotegrænse (fx `"Individual quota reached. Please upgrade your subscription to increase your limits. Resets..."`) og venter på nulstilling |
| Færdig | Agenten er stadig åben ved prompten, men har afsluttet opgaven uden spørgsmål |
| Åben | En almindelig terminal |
| Afsluttet / Fejlet | Sessionen er slut (fejlet = sluttede med en fejlkode) |

"Venter på dig" og "Venter på xxxx" er et skøn ud fra aktivitet, underprocesser og terminalens seneste linjer.

## Sikkerhed

Control Tower kan starte terminaler på din maskine, så adgangen er låst ned:

- Serveren lytter kun på `127.0.0.1` – andre enheder på netværket kan ikke nå den.
- Hver start laver en ny tilfældig nøgle. Uden den er alle data låst.
- Nøglen sendes i en header, ikke i en cookie. Browsere sender cookies til alle porte på din maskine, så en anden lokal webside ville ellers få nøglen med. Nøglen gemmes i browseren under Control Towers egen adresse og port og fjernes fra adresselinjen med det samme.
- Forespørgsler fra andre websites og andre lokale porte afvises (tjek af værtsnavn og afsender), også for terminal-forbindelsen.
- En skæv eller ødelagt forespørgsel bliver afvist og kan ikke vælte programmet.
- Browseren kan kun vælge en agent via dens id. Selve kommandoen står i din indstillingsfil.
- Fra din hjemmemappe læses kun `SKILL.md`-filer under skills-mappen samt token-tal, modelnavn, tidsstempel og projektsti fra `.jsonl`-logfiler i `~/.claude/projects` og `~/.gemini/antigravity-cli/brain` – aldrig nøgler eller samtaleindhold.
- Repos og hjerne-filer slås op på en liste, så stier som `../..` ikke virker, og symlinks ud af et repo vises ikke.
- Indhold fra filer og GitHub vises som tekst og kan ikke køre kode i browseren.
- Tekst (issue, review, skill-beskrivelse) indsættes kun hos en agent, aldrig i en almindelig terminal, og sendes først når du trykker Enter. Læs den igennem først: issues og reviews er tekst skrevet af andre. Ligger der allerede en usendt tekst hos agenten, afvises en ny, så de ikke bliver klistret sammen.
- Nøglen står stadig i terminalen, hvor du startede programmet. Alle, der kan læse den terminal, kan åbne Control Tower, så længe det kører.

Control Tower ændrer ikke selv noget i dine repos. Det du og agenterne gør i terminalen, gør I med dine normale rettigheder.

## Test

```bash
npm test
```

## Kendte begrænsninger

- Sessioner lever så længe Control Tower kører. Stopper du programmet (Ctrl+C), lukkes alle terminaler og agenter – også dem der ikke selv vil stoppe.
- "Venter på dig" betyder kun, at agenten har været stille. En agent der arbejder uden at skrive noget, ser også sådan ud.
- Markdown-visningen er enkel: understregning som kursiv, links med parenteser og indlejrede nummererede lister vises ikke korrekt.
- Tastatur: F6 flytter fokus ud af terminalen.
- Kun git-repos direkte i rodmappen vises (ikke undermapper).
- Udviklet og testet på Linux. Mac og Windows bruger samme kode og færdigbyggede terminal-moduler, men er ikke afprøvet endnu.
