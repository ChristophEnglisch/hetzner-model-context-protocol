# hetzner-model-context-protocol

> Status: **Planung**, Stand 2026-10-30. Es gibt noch keinen Code.

MCP-Server für die Hetzner Cloud API, gebaut nach dem Muster von
[`keycloak-model-context-protocol`](../keycloak-model-context-protocol/): ein zentraler
`defineTool`-Wrapper, ein Gateway als einziger Weg zur API, Guards vor jedem Schreibzugriff,
strukturierte Ausgaben und Tests auf drei Ebenen.

Ausgangspunkt ist eine Lückenanalyse von [`mcp-hetzner`](../mcp-hetzner/) (dkruyt, Python,
v0.1.0). Ziel ist kein Fork, sondern ein Neuaufbau.

## Planungsunterlagen

| Datei                                                                                                          | Inhalt                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [unter-verschluss/analysis/01-luecken-mcp-hetzner.md](unter-verschluss/analysis/01-luecken-mcp-hetzner.md)     | Befunde HZ-01..HZ-24 mit Fundstelle, verglichen mit dem Keycloak-MCP                                                                 |
| [unter-verschluss/analysis/02-zielarchitektur.md](unter-verschluss/analysis/02-zielarchitektur.md)             | Was vom Keycloak-MCP übernommen wird, was Hetzner-spezifisch neu ist                                                                 |
| [unter-verschluss/analysis/03-feature-brainstorming.md](unter-verschluss/analysis/03-feature-brainstorming.md) | Toolsets, Features zum Abheben, bewusst Weggelassenes                                                                                |
| [unter-verschluss/roadmap-1.0.md](unter-verschluss/roadmap-1.0.md)                                             | Phasen bis 1.0 und danach, offene Entscheidungen                                                                                     |
| [unter-verschluss/umsetzung/00-plan.md](unter-verschluss/umsetzung/00-plan.md)                                 | **Einstieg Umsetzung:** Arbeitspakete, Modellzuordnung, Ablauf; von dort zu Kern-, Tool-, Feature-Spec, Briefings und Konsolidierung |

Der Ordner `unter-verschluss/` folgt der Konvention des Keycloak-Repos: interne Unterlagen,
die später per `.gitignore` aus dem öffentlichen Repo herausgehalten werden.
# hetzner-model-context-protocol
