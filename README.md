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

## Indstillinger

Første start opretter `control-tower.config.json` (filen er ikke med i git). En eksisterende fil bliver aldrig overskrevet – kun `root` ændres, hvis du starter med en ny sti.

```json
{
  "root": "/Users/dig/Projects",
  "port": 4317,
  "brainPaths": ["docs", "CLAUDE.md", "AGENTS.md", ".claude"],
  "agents": [
    { "id": "claude", "name": "Claude Code", "command": "claude" },
    { "id": "anden", "name": "Anden agent", "command": "din-agent-kommando" }
  ],
  "idleSeconds": 8,
  "maxSessions": 12
}
```

- `agents` er listen over knapper i interfacet. Kun kommandoer på denne liste kan startes som agent.
- `brainPaths` er de mapper og filer i hvert repo, der vises under "Hjerne" (kun .md, .mdx og .txt).
- `idleSeconds` er hvor længe en agent skal være stille, før status skifter fra "Arbejder" til "Venter på dig".

## Overblikket

Øverst står altid det næste skridt: hvilken agent der venter på dig, eller at alt kører. Under "Arbejdspladser" har hver agent en figur ved et skrivebord: den skriver når den arbejder, rækker hånden op når den venter, og taleboblen viser den seneste linje fra agenten. Taleboblen er et skøn – agenter der tegner hele skærmen om, kan vise en bundlinje i stedet for en besked. "Start agent" på et repo-kort starter den første agent på din liste.

## Resumé af agentens arbejde

Når en agent venter eller er færdig, viser dens kort og terminalvisning et resumé: hvor længe den kørte, nye commits, og hvilke filer der er ændret siden start. Filer du selv havde ændret, før agenten startede, markeres. Resuméet bygger kun på git og kalder ingen model, så det viser alt der er ændret i repoet i perioden – også det du selv eller en anden agent har lavet imens. Knappen "Bed om resumé" indsætter et spørgsmål hos agenten, hvis du vil have dens egen forklaring i ord.

## Issues

Fanen Issues viser repoets åbne GitHub-issues (via `gh`). Åbn et issue, og send det til en kørende agent. Har repoet en skill til issues, kan du vælge den – så sendes kun `/skill-navn nummer`, og agenten henter selv issuet. Uden skill sendes titel og beskrivelse. Valget huskes pr. repo i din browser. Control Tower ændrer ikke noget på GitHub.

## Skills

Fanen Skills i et repo viser repoets egne skills (`.claude/skills` og ældre `.claude/commands`) og dine personlige (`~/.claude/skills`, inkl. dem der er synkroniseret fra claude.ai). Punktet Skills i menuen viser dem alle samlet. Har et repo og din personlige mappe en skill med samme navn, markeres repoets som overskygget, fordi Claude Code bruger den personlige.

Control Tower læser kun skills. En ny skill laves ved at udfylde formularen: beskrivelsen indsættes hos en kørende agent, som skriver filen, og du trykker selv Enter. Findes navnet allerede, bedes agenten forbedre den eksisterende i stedet for at overskrive den. Stien til personlige skills kan ændres med `personalSkillsDir` i indstillingsfilen.

## Beskeder, lyd og fanens titel

Knapperne "Beskeder" og "Lyd" øverst er slået fra, indtil du selv slår dem til. Med beskeder til får du en notifikation fra browseren, når en agent venter på dig, går ned eller bliver færdig – medmindre du allerede kigger på netop den agent, eller selv har stoppet den. Lyden er to korte toner. Fanens titel viser altid antallet først og derefter en lille kommentar, fx "(1) Agenten tripper". Valgene huskes i din browser.

## Status

| Status | Betyder |
|---|---|
| Arbejder | Agenten skriver til terminalen lige nu |
| Venter på xxxx | Ingen ny tekst i `idleSeconds` sekunder, men der kører subagenter, tests, emulator, build m.m. |
| Venter på dig | Ingen aktivitet i `idleSeconds` sekunder og ingen aktive underopgaver – den venter på svar eller godkendelse |
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
- Fra din hjemmemappe læses kun `SKILL.md`-filer under skills-mappen – aldrig andre filer i `~/.claude`.
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
- Den valgte fane og det åbne issue huskes ikke i adressen, så en genindlæsning går tilbage til overblikket.
- Markdown-visningen er enkel: understregning som kursiv, links med parenteser og indlejrede nummererede lister vises ikke korrekt.
- Tastatur: F6 flytter fokus ud af terminalen.
- Kun git-repos direkte i rodmappen vises (ikke undermapper).
- Udviklet og testet på Linux. Mac og Windows bruger samme kode og færdigbyggede terminal-moduler, men er ikke afprøvet endnu.
