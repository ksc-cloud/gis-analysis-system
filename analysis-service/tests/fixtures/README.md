# Test fixtures

- `real/` (Git-ignored): real Java radius analysis results for `tests/test_java_real_results.py`.
  Save the JSON body of `GET /api/buildings/nearby` or `GET /api/analyses/{id}` as `real/<name>.json`.
  These contain real addresses and building names, so they are never committed.
- Synthetic data that is committed lives in `tests/data/` and is generated in `tests/factories.py`.
