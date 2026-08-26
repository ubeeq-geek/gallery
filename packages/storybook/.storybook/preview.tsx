import type { Preview } from "@storybook/react";
import "@gallery/design-system/tokens.css";

const preview: Preview = {
  globalTypes: { theme: { description: "Product semantic theme", toolbar: { icon: "paintbrush", items: ["ubeeq", "eversally", "nightframe"] } } },
  initialGlobals: { theme: "ubeeq" },
  decorators: [(Story, context) => <main data-product-theme={context.globals.theme} style={{ background: "var(--ds-surface-canvas)", minHeight: "100vh", padding: "2rem", fontFamily: "system-ui" }}><Story /></main>],
  parameters: { a11y: { test: "error" }, controls: { expanded: true }, options: { storySort: { order: ["Foundations", "Primitives", "Patterns", "Domain", "Feature flows"] } } }
};
export default preview;
