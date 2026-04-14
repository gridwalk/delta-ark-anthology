# Delta Ark Anthology

A static website for the Delta Ark Anthology — a curated collection of new media art works exploring ecology, machine learning, and politics. Produced by [Source Material](https://sourcematerial.org), Seattle.

The site serves as both a teaser for an upcoming book and a standalone online presence for the anthology.

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

The site is deployed via GitHub Pages. Pushing to the `main` branch automatically triggers a GitHub Actions workflow that builds the site and publishes the `dist/` folder. No manual build step required.

See `docs/deploy-plan.md` for the full deployment setup guide.

---

## Content guidelines

- **Videos** — host on Vimeo or YouTube, embed using the platform's embed URL
- **Images** — include in the artist's `images/` folder; keep file sizes reasonable
- **Essays** — if hosted externally, link via `essay_url` in frontmatter; if included as text, write directly in the markdown body
- **Folder names** — use lowercase and hyphens only, e.g. `jean-pierre-dupont`
