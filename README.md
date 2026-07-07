# Delta Ark Anthology

A static website for the Delta Ark Anthology — a curated collection of new media art works exploring ecology, machine learning, and politics. Produced by [Source Material](https://sourcematerial.org), Seattle.

The site serves as both a teaser for an upcoming book and a standalone online presence for the anthology.

**Live site:** [delta-ark-anthology.futurefocus.studio](https://delta-ark-anthology.futurefocus.studio/)

---

## Tech stack

| Tool | Role |
|------|------|
| [Node.js](https://nodejs.org) (v24) | Runtime for the build script |
| [Nunjucks](https://mozilla.github.io/nunjucks/) | HTML templating (`templates/*.njk`) |
| [marked](https://marked.js.org/) | Renders markdown bodies to HTML |
| [gray-matter](https://github.com/jonschlinkert/gray-matter) | Parses YAML frontmatter from `index.md` files |
| [chokidar](https://github.com/paulmillr/chokidar) | File watching for `npm run watch` |
| GitHub Actions + GitHub Pages | Automated build and hosting |

The generator itself is a single ~180-line script, `build.js`. There is no framework, database, CMS, or server.

---

## How it works

This is a custom static site generator. Artist content lives as markdown files in the `artists/` directory. Running the build script compiles everything into plain HTML in the `dist/` folder, which is what gets deployed.

There is no database, no CMS, and no server required. Content is edited directly as text files.

### Site structure

```
delta-ark-anthology/
├── artists/                  # One folder per artist
│   └── firstname-lastname/
│       ├── index.md          # Artist metadata and bio
│       └── images/           # Still images for this artist
├── templates/                # Nunjucks HTML templates
│   ├── base.njk              # Shared page shell (nav, head, footer)
│   ├── artist.njk            # Individual artist page template
│   ├── toc.njk               # Table of contents template
│   └── home.html             # Splash page (hand-crafted HTML)
├── static/                   # CSS, JS, global images
├── build.js                  # The build script
└── dist/                     # Compiled output — do not edit directly
```

### Pages

| Page | URL | Source |
|------|-----|--------|
| Homepage | `/` | `templates/home.html` |
| Table of contents | `/toc/` | Auto-generated from all artist folders |
| Artist page | `/artists/firstname-lastname/` | `artists/firstname-lastname/index.md` |

---

## Adding an artist

1. Create a new folder under `artists/` named as `firstname-lastname` (lowercase, hyphenated)
2. Add an `index.md` file with the following frontmatter:

```markdown
---
name: Artist Name
country: France
medium: Video, Essay
year: 2025
video_url: https://player.vimeo.com/video/000000000
featured_image: images/still.jpg
essay_url: https://example.com/essay
order: 5
---

Bio and artist statement in markdown here...
```

3. Drop any still images into the `images/` subfolder
4. Run the build (see below)

All frontmatter fields are optional except `name`. Videos should be hosted on Vimeo or YouTube — use the embed URL, not the regular watch URL. Images (stills, portraits) live in the repo.

The table of contents is generated automatically from all artist folders. Artists are ordered by the `order` field if present, then alphabetically by name.

---

## Running the build

Install dependencies (first time only):

```bash
npm install
```

Build the site:

```bash
npm run build
```

Output is written to `dist/`. To preview locally, open `dist/index.html` in a browser or use any static file server:

```bash
npx serve dist
```

Watch mode (rebuilds automatically when files change):

```bash
npm run watch
```

---

## Deployment

The site is deployed via GitHub Pages. Pushing to the `main` branch automatically triggers a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds the site with Node 24 and publishes the `dist/` folder. No manual build step required.

The live site is served from a custom domain:

- **URL:** https://delta-ark-anthology.futurefocus.studio/
- **Repository:** [`gridwalk/delta-ark-anthology`](https://github.com/gridwalk/delta-ark-anthology)
- **Domain config:** the custom domain is set in **Settings → Pages**; an HTTPS certificate is provisioned automatically by GitHub.

The editing-to-live flow is:

1. Edit or add files in `artists/`, `templates/`, or `static/`
2. Commit and push to `main`
3. GitHub Actions builds and deploys (about 20–60 seconds)
4. The live site updates automatically

See `docs/deploy-plan.md` for the full one-time setup guide (repo creation, workflow, Pages, and custom-domain DNS).

---

## Content guidelines

- **Videos** — host on Vimeo or YouTube, embed using the platform's embed URL
- **Images** — include in the artist's `images/` folder; keep file sizes reasonable
- **Essays** — if hosted externally, link via `essay_url` in frontmatter; if included as text, write directly in the markdown body
- **Folder names** — use lowercase and hyphens only, e.g. `jean-pierre-dupont`
