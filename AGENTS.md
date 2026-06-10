# Repository Guidelines

## Project Structure & Module Organization
This repo contains a TypeScript backend and a React frontend:
- `backend/src/`: Express server and data-processing modules (`index.ts`, `data.ts`, `rag.ts`, `eyGuideData.ts`)
- `frontend/src/`: Vite + React UI (`main.tsx`, `App.tsx`, styles in `App.css`/`index.css`)
- `Mobility/`: local data artifacts (survey workbook and generated cache/index JSON files)

Build outputs (`dist/`) and dependencies (`node_modules/`) exist in both apps and should not be edited directly.

## Data Sources
The RAG flow uses exactly two business data sources:
- Survey data: `Mobility/Mobility_survey_data - Full 100 Assignees.xlsx`
- EY guide content: extracted from EY Worldwide Personal Tax and Immigration Guide (live fetch with local cache in `Mobility/_ey_worldwide_guide_cache.json`)

## Build, Test, and Development Commands
Run commands from each package directory:

```bash
# Backend
cd backend
npm run dev        # start API with tsx
npm run typecheck  # TS type checking
npm run build      # compile to dist/

# Frontend
cd frontend
npm run dev        # start Vite dev server
npm run lint       # ESLint checks
npm run build      # TS + production bundle
```

## Coding Style & Naming Conventions
Use TypeScript across backend and frontend. Follow existing patterns:
- 2-space indentation
- `camelCase` for variables/functions
- `PascalCase` for React components
- Keep modules focused and colocate logic by domain (API/data in backend, UI in frontend)

Use existing tooling (`eslint` in frontend, `tsc` type checking in both apps) before opening a PR.

## Testing Guidelines
There is no dedicated automated test suite yet. For now, treat quality gates as:
- Backend: `npm run typecheck && npm run build`
- Frontend: `npm run lint && npm run build`

Do not run validators on every small code edit during iteration; run them at milestone points (before handoff, commit, or release checks).

When adding tests later, prefer colocated `*.test.ts(x)` files next to source modules.

## Commit & Pull Request Guidelines
Current history uses short, imperative commit messages (e.g., `Add .gitignore, remove node_modules from tracking`). Keep commits focused and descriptive.

PRs should include:
- clear summary of intent and scope
- linked issue/task (if available)
- validation steps run locally
- screenshots/GIFs for UI changes in `frontend`

## Security & Configuration Tips
Do not commit secrets or raw sensitive data. Keep backend environment values in `backend/.env` only, and avoid committing large regenerated artifacts unless explicitly required.
