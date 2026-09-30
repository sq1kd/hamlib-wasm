/**
 * Test helpers injected into the page as text.
 *
 * `capture()` normalises every outcome into a structured-clone-safe value, so
 * specs can assert on `HamlibError` fields without relying on Playwright's
 * error serialisation.
 */
(function installTestHelpers() {
  /** @param {unknown} error */
  function describeError(error) {
    var harness = window.__hamlibHarness;
    var value = /** @type {Record<string, unknown>} */ (error);
    var cause = value ? value.cause : null;

    return {
      name: value && value.name ? String(value.name) : null,
      message: value && value.message ? String(value.message) : String(error),
      code: value && value.code ? String(value.code) : null,
      operation: value && value.operation ? String(value.operation) : null,
      hamlibCode: typeof (value && value.hamlibCode) === 'number' ? value.hamlibCode : null,
      hamlibMessage: value && value.hamlibMessage ? String(value.hamlibMessage) : null,
      cause: cause && cause.name
        ? String(cause.name) + ': ' + String(cause.message)
        : (cause === null ? null : String(cause)),
      isHamlibError: Boolean(harness && harness.isHamlibError(error)),
    };
  }

  window.__testHelpers = {
    describeError: describeError,
    capture: async function (action) {
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    },
  };
})();
