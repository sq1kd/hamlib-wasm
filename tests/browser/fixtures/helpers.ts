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
    var harness = window.__hamlibHarness;
    var value = error as { [key: string]: unknown } | null;
    var cause = value ? value['cause'] : null;
    /* `cause` is only read through `.name` and `.message`, and only when it is
     * truthy, which is why a failed cast on a primitive cause is harmless. */
    var named = cause as { name?: unknown; message?: unknown } | null;
    var hamlibCode = value ? value['hamlibCode'] : null;

    return {
      name: value && value['name'] ? String(value['name']) : null,
      message: value && value['message'] ? String(value['message']) : String(error),
      code: value && value['code'] ? String(value['code']) : null,
      operation: value && value['operation'] ? String(value['operation']) : null,
      hamlibCode: typeof hamlibCode === 'number' ? hamlibCode : null,
      hamlibMessage: value && value['hamlibMessage'] ? String(value['hamlibMessage']) : null,
      cause: cause && named && named.name
        ? String(named.name) + ': ' + String(named.message)
        : (cause === null ? null : String(cause)),
      isHamlibError: Boolean(harness && harness.isHamlibError(error)),
    };
  }

  window.__testHelpers = {
    describeError: describeError,
    capture: async function <T>(
      action: () => T | Promise<T>,
    ): Promise<CapturedView<Awaited<T>>> {
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    },
  };
})();
