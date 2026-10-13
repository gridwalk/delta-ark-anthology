---
title: Move the numbered-holds hook into arcology-ship
created: 2026-10-12
priority: high
assignee: human
---
The numbered holds on the homepage need three messages from the ship: `ship:hold`, `ship:anchor` and `ship:focus`. For now they come from a block appended to the built bundle, `embeds/ship/assets/index-CddNyexW.js`, after the comment "Added on top for the numbered-holds layer". Everything above that comment is arcology-ship's build, unchanged.

The block uses the build's minified names for the ship, the main camera, its controls, the camera flight, the lit group and the growth rate (`sI`, `eI`, `tI`, `DI`, `aI`, `PF`). Move it into arcology-ship's source under the source names before the bundle is next rebuilt. A rebuild without it still leaves a working homepage, but the tags, the line and the flight stop appearing.
