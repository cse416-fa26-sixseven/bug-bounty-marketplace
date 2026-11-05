/** True when the browser serves the API from MSW mocks instead of a real API.
 *
 * On unless NEXT_PUBLIC_API_MOCKING=disabled, so the frontend MVP runs on its
 * own by default. Next inlines the value at build time, which is why the
 * mocked web image is a separate build (`<tag>-mocked`). Read per call so
 * tests can stub the env var. */
export function isMockingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";
}
