/**
 * React's `act` refuses to run outside a declared act environment, and the
 * hook tests render into jsdom instead of a browser.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
