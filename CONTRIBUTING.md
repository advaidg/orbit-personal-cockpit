# Contributing to Orbit

Orbit is building a private attention layer across the tools people already use. Contributions should reduce cognitive load, not add another stream to monitor.

## Good first contributions

- Add a source adapter that emits normalized `Signal` objects.
- Improve non-AI classification rules.
- Add export, deletion, or privacy controls.
- Improve accessibility or mobile behavior.
- Add tests around OAuth, synchronization, and task extraction.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

The sample workspace works without credentials or PostgreSQL. Run `npm run check` and `npm run build` before opening a pull request.

## Connector principles

1. Ask for the smallest possible permission scope.
2. Work usefully without an AI key.
3. Convert provider data into `Signal`; do not leak provider-specific logic into the dashboard.
4. Store secrets only on the server, encrypted at rest.
5. Never create a task from a passive notification unless the user asks.

Please open an issue before a large architectural change.
