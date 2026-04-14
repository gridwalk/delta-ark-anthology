# Deploy Plan — GitHub Pages + GitHub Actions

This document outlines the steps to set up automated deployment for the Delta Ark Anthology site. Once complete, pushing any change to the `main` branch will automatically build and publish the site.

---

## Overview

| Service | Purpose | Cost |
|---------|---------|------|
| GitHub (public repo) | Source code and content hosting | Free |
| GitHub Actions | Runs the build on every push | Free (2,000 min/month) |
| GitHub Pages | Serves the compiled `dist/` folder | Free |
| Custom domain (optional) | Point a domain at the GitHub Pages URL | Free on GitHub's side; domain registration cost only |

---

## Step 1 — Create the GitHub repository

1. Go to [github.com](https://github.com) and sign in
2. Click **New repository**
3. Name it (e.g. `delta-ark-anthology`)
4. Set visibility to **Public**
5. Do not initialize with a README (we already have one)
6. Click **Create repository**

---

## Step 2 — Push the local project to GitHub

From the project directory on your machine:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/delta-ark-anthology.git
git push -u origin main
```

Replace `YOUR_USERNAME` with the actual GitHub username or organization.

---

## Step 3 — Add the GitHub Actions workflow

Create the file `.github/workflows/deploy.yml` in the project:

```yaml
name: Build and Deploy

on:
  push:
    branches:
      - main

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build site
        run: npm run build

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

Commit and push this file. The workflow will run automatically on every subsequent push to `main`.

---

## Step 4 — Enable GitHub Pages

1. In the GitHub repository, go to **Settings → Pages**
2. Under **Source**, select **GitHub Actions**
3. Save

After the next push, the site will be live at:
```
https://YOUR_USERNAME.github.io/delta-ark-anthology/
```

---

## Step 5 — Custom domain (optional)

If the project has its own domain (e.g. `deltaarkanthology.com`):

### On GitHub

1. Go to **Settings → Pages → Custom domain**
2. Enter the domain and click **Save**
3. GitHub will add a `CNAME` file to the repository automatically

### With your DNS provider

Add the following DNS records at your domain registrar:

**For an apex domain** (e.g. `deltaarkanthology.com`):

| Type | Name | Value |
|------|------|-------|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |

**For a subdomain** (e.g. `www.deltaarkanthology.com`):

| Type | Name | Value |
|------|------|-------|
| CNAME | www | YOUR_USERNAME.github.io |

DNS changes can take up to 48 hours to propagate. GitHub will provision an SSL certificate automatically once the domain resolves.

---

## Workflow summary

Once everything is set up, the content editing workflow is:

1. Edit or add files in `artists/`, `templates/`, or `static/`
2. Commit and push to `main`
3. GitHub Actions builds the site (takes about 30–60 seconds)
4. The live site updates automatically

No manual builds, no FTP, no server access required.
