# Kontent.ai Custom App Starter

A React + TypeScript starter template for building [Kontent.ai custom apps](https://kontent.ai/learn/docs/build-apps/custom-apps/overview). This template provides a quick setup with all the essentials to start developing your custom app.


## Getting Started

### Installation

```bash
pnpm i
```

### Development

Start the development server:

```bash
pnpm dev
```

The app will be available at `https://localhost:5173`. The dev server uses a self-signed certificate for HTTPS, which is required for custom apps. Your browser will show a security warning on first access - this is expected for local development.

### Build

Build for production:

```bash
pnpm build
```

Preview the production build:

```bash
pnpm preview
```

## Examples

### Observing Context Changes

The `useAppContext` hook automatically subscribes to context changes:

```typescript
import { useAppContext } from './contexts/AppContext';

const context = useAppContext();
```

### Accessing App Configuration

The `useAppConfig` hook returns the parsed app configuration:

```typescript
import { useAppConfig } from './contexts/AppContext';

const config = useAppConfig();
```

### Single Context Fetch

While the SDK provides `getCustomAppContext()` for fetching the context once without subscribing to changes, **we recommend using the reactive `useCustomAppContext` hook instead**. The hook ensures your app stays up-to-date with the latest context automatically.

If you need a single fetch for specific use cases:

```typescript
import { getCustomAppContext } from '@kontent-ai/custom-app-sdk';

const response = await getCustomAppContext();
if (!response.isError) {
  console.log(response.context);
}
```

### Restricting Supported Contexts

By default, the app supports all page contexts (Item Editor, Content Inventory, and Other). To restrict your app to specific contexts, edit the `createAppContext` call in [`src/contexts/AppContext.tsx`](./src/contexts/AppContext.tsx):

```typescript
// Only allow Item Editor context
export const { AppContextProvider, useAppContext, useAppConfig } = createAppContext([
  "itemEditor",
] as const);

// Allow Item Editor and Content Inventory
export const { AppContextProvider, useAppContext, useAppConfig } = createAppContext([
  "itemEditor",
  "contentInventory",
] as const);
```

When a restricted context is configured:
- If the app is opened in an unsupported context, a friendly error page is displayed
- TypeScript narrows the return type of `useAppContext()` based on the allowed contexts

For example, with `["itemEditor"]`, the `useAppContext()` hook returns `CustomAppItemEditorContext` with guaranteed access to `contentItemId` and `validationErrors` properties.

### Adjusting Popup Size

Control the size of your custom app when displayed in a popup:

```typescript
import { setPopupSize } from '@kontent-ai/custom-app-sdk';

await setPopupSize(
  { unit: 'px', value: 800 },  // width
  { unit: 'px', value: 600 }   // height
);
```

## Deploying Your Custom App

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/kontent-ai/custom-app-starter-react.git)

1. Build the app: `pnpm build`
2. Deploy the `dist` folder to your hosting provider (Netlify, Vercel, etc.)
3. Configure the custom app in Kontent.ai:
   - Go to Environment settings > Custom apps
   - Add a new custom app with your deployed URL
   - Configure the URL pattern where the app should appear
   - Optionally, change the app to the dialog mode

## Learn More

- [Kontent.ai Custom Apps Documentation](https://kontent.ai/learn/docs/build-apps/custom-apps/overview)
- [Kontent.ai Custom App SDK](https://github.com/kontent-ai/custom-app-sdk-js)

## License

MIT
