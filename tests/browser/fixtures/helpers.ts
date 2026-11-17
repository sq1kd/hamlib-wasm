/**
 * Test helpers compiled to `generated/helpers.js` by the neighbouring
 * tsconfig.json and injected into the page as *text* (see
 * tests/browser/fixtures.ts).
 *
 * `capture()` normalises every outcome into a structured-clone-safe value, so
 * specs can assert on `HamlibError` fields without relying on Playwright's
 * error serialisation.
 */

(function installTestHelpers() {
  function describeError(error: unknown): HamlibErrorView {
    /* Published by the harness page on load, so absent while init scripts run. */
    var harness = (window as { __hamlibHarness?: { isHamlibError(value: unknown): boolean } })
      .__hamlibHarness;
    var value = error as { [key: string]: unknown } | null;
    var cause = value ? value.cause : null;
    /* `cause` is only read through `.name` and `.message`, and only when it is
     * truthy, which is why a failed cast on a primitive cause is harmless. */
    var named = cause as { name?: unknown; message?: unknown } | null;
    var hamlibCode = value ? value.hamlibCode : null;

    return {
      name: value?.name ? String(value.name) : null,
      message: value?.message ? String(value.message) : String(error),
      code: value?.code ? String(value.code) : null,
      operation: value?.operation ? String(value.operation) : null,
      hamlibCode: typeof hamlibCode === 'number' ? hamlibCode : null,
      hamlibMessage: value?.hamlibMessage ? String(value.hamlibMessage) : null,
      cause: cause && named?.name
        ? String(named.name) + ': ' + String(named.message)
        : (cause === null ? null : String(cause)),
      isHamlibError: Boolean(harness?.isHamlibError(error)),
    };
  }

  window.__testHelpers = {
    describeError: describeError,
    catalogueModel: function <T extends CatalogueEntry>(
      models: readonly T[],
      manufacturer: string,
      model: string,
    ): T {
      var found = models.find(function (candidate) {
        return candidate.manufacturer === manufacturer && candidate.model === model;
      });

      if (found) { return found; }

      var siblings = models
        .filter(function (candidate) { return candidate.manufacturer === manufacturer; })
        .map(function (candidate) { return candidate.model; });

      throw new Error(
        manufacturer + ' ' + model + ' is not in the catalogue; '
        + manufacturer + ' entries: ' + (siblings.join(', ') || 'none'),
      );
    },
    capture: async function <T>(
      action: () => T | Promise<T>,
    ): Promise<Captured<Awaited<T>>> {
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    },
  };
})();
