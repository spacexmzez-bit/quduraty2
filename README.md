# Quduraty — Tahsili update

## Files

- `index.html`: existing Aptitude app with a navigation sidebar. Replace your current file with it.
- `tahsili.html`: separate Tahsili app with subject filter, groups, lessons, types, question cards, quizzes, stars, review and manual sync.
- `tahsili-template.json`: Tahsili import template. Upload it beside both HTML pages.
- `worker.js`: updated Worker based on the provided Worker code; the existing Aptitude routes remain at `/state`, `/batch`, etc. Tahsili uses `/tahsili/state`, `/tahsili/batch`, etc.
- `wrangler.toml`: deployment configuration. Fill in EVERY placeholder before deployment.
- `deploy.txt`: GitHub Actions workflow content. On GitHub create `.github/workflows/deploy.yml` and paste this text into it. Do not upload deploy.txt as a workflow and do not enable both GitHub Actions and Cloudflare Builds for the same Worker.
- `sql-guide.html`: open this page for the new Tahsili D1 schema with a copy button.

## Set up the backend first

1. Create a **new** D1 database for Tahsili. Open `sql-guide.html` and run its SQL in the new database's SQL console. Do not run it in your existing Aptitude database.
2. In `wrangler.toml`, use your EXISTING Worker name, existing Aptitude D1 name and database ID under binding `DB`, new Tahsili D1 name and database ID under `TAH_DB`, existing R2 bucket under `FILES`, and your exact frontend origin in `ALLOWED_ORIGINS`. Match all existing Worker settings and add any other pre-existing variables or bindings before deploying, since Wrangler configuration controls the deployed Worker.
3. Add GitHub repository secrets named `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Create `.github/workflows/deploy.yml` and paste the content of `deploy.txt`. Add `worker.js` and your edited `wrangler.toml` to the repository root. A push to `main` changing these files triggers deployment; the workflow can also be run manually. Keep the API token in GitHub secrets, never in repository code.
4. Confirm the existing Worker `/state` works and the new `/tahsili/state` returns an empty snapshot. If you use Cloudflare Builds instead, remove or disable the GitHub workflow to prevent double deployments.
5. Upload `index.html`, `tahsili.html`, and `tahsili-template.json` together in the same frontend directory. The Aptitude and Tahsili tabs link to each other. In each page use the same Worker base URL in إعداد المزامنة; Tahsili automatically uses its separate endpoint. Click مزامنة الآن on the relevant page to sync it. Merely opening a page does not sync.

Both sections use separate IndexedDB local vaults, sync caches and D1 databases. Delete all only clears the section where you invoke it, with server deletion on its next manual sync. R2 file objects are shared but identified by random keys; each page removes its own registered attachments. Old local copies on other devices require their own manual sync. Pending edits stay local until sync, and failures remain pending with details visible by pressing the red dot.

## Tahsili JSON

Use `tahsili-template.json` as a starting point. `subject` accepts رياضيات, فيزياء, أحياء, كيمياء, مهارات. Question `type` accepts خطأ, سؤال صعب, سؤال خادع. Groups contain `lessons`, each with `num`, `title`, and `questions`. A flat array or `{ "questions": [...] }` also works; each flat question needs `subject`, `type`, `group`, `lessonNum`, `lessonTitle`, `text`, `options`, and `correct`.

There are at most four option slots. Empty options are permitted, but at least one must be filled and the selected correct option must be filled. Original positions are preserved; for `["", "ب", "ج", ""]`, `correct: 2` means ج. Numeric answers are zero-based; set `indexBase: 1` on the question to use one-based numbers. Answers can also use A/B/C/D, أ/ب/ج/د, or an exact unique option text. Import validation happens before local writes. Attach photos using the add-question form; this template imports text and choices only.

## Testing and deployment

The delivered files were checked with JavaScript syntax validation and simulated parser and server isolation tests. A real browser and your Cloudflare account have not been used for deployment testing. After deployment, test with sample data: sync each section, create a Tahsili question with an empty option before the correct option, sync, reload and quiz; then test deletion in Tahsili and verify Aptitude is still present. No authentication is configured: anyone who knows the Worker URL can access and alter the data; origin restrictions do not prevent direct requests.
