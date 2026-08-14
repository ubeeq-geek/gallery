# Product branding

Ubeeq is the open-source platform and project. Eversally is the commercial hosted product built on Ubeeq. Branding changes product-facing language and canonical links without forking application behaviour or renaming persisted data.

## Terminology

| Concept | Eversally hosted | Ubeeq OSS |
| --- | --- | --- |
| Product | Eversally | Ubeeq |
| Public domain | `https://eversally.com` | `https://ubeeq.site` |
| Registered member | Ever / Evers | Ubeeqer / Ubeeqers |
| Creator | Creator / Creators (`Ever Creator` only when the formal distinction matters) | Creator / Creators |
| Creator workspace | Eversally Space / Spaces | Ubeeq Creator Area / Creator Areas |
| Studio | Eversally Studio | Ubeeq Studio |
| Hosted attribution | Powered by Ubeeq | None |

An Ever and an Ever Creator are not separate account types. “Ever” describes membership; “Ever Creator” describes a member acting through a creator identity. Approval or invitation-based support remains a separate entitlement.

## Colour systems

The editions share typography, spacing, component geometry, and the circular platform mark. Colour supplies the product personality without creating a separate design system.

| Role | Eversally hosted | Ubeeq OSS |
| --- | --- | --- |
| Primary | Muted violet `#8063B5` | Muted teal `#397C76` |
| Strong primary | Deep muted violet `#62488F` | Deep muted teal `#2B625D` |
| Primary action | Muted coral `#C44560` | Deep muted teal `#2B625D` |
| Highlight | Dusty magenta `#A95079` | Muted amber `#9A6828` |
| Soft brand surface | Grey-lavender `#F0EDF4` | Grey-teal `#E9EFEE` |
| Default page background | Neutral grey-white `#F6F7F8` | Neutral grey-white `#F6F7F8` |
| Default text | Neutral black `#19181C` | Neutral black `#17191C` |

Both editions use white, grey, charcoal, and near-black for their structural surfaces. Eversally reserves violet and coral for identity, navigation state, and important calls to action. Ubeeq uses muted teal in the same selective roles, with amber reserved for small highlights and non-error attention cues. Success, warning, and error colours remain semantic and do not change meaning between editions.

These values live as `--brand-*` custom properties in `apps/web/src/styles.css`. The active `data-product-brand` attribute selects them at runtime; no component should hard-code an edition colour.

### Appearance modes

Colour mode is a per-browser preference and is intentionally separate from the administrator-selected site theme. It supports `system`, `light`, and `dark`, defaults to `system`, and follows operating-system changes while that default remains selected. The preference is stored under `ubeeq.appearance`; the resolved mode is exposed as `data-color-scheme="light|dark"` on the document root.

Dark mode uses shared near-black and charcoal foundations. Eversally adds restrained violet and coral controls, while Ubeeq adds restrained teal and amber controls. Semantic status colours are adjusted for dark-surface contrast without changing their meaning.

## Runtime contract

The web manifest is `apps/web/src/brand.ts`. `VITE_PRODUCT_BRAND` accepts `eversally` or `ubeeq`; an unknown or absent value safely falls back to Ubeeq. `VITE_CREATOR_BASE_URL` can override the selected edition's canonical creator URL.

The API manifest is `apps/api/src/brand.ts`. `PRODUCT_BRAND` accepts `eversally` or `ubeeq`; an unknown or absent value safely falls back to Ubeeq. The CDK stack passes this setting to API and synchronization workers and uses it for Cognito verification-email branding.

Local commands default to Eversally because local development primarily exercises the hosted product:

```bash
npm run dev:eversally
```

Run the open-source presentation with:

```bash
npm run dev:ubeeq
```

Use `npm run dev:all` to run both complete pairs concurrently. Eversally uses web/API ports `5174`/`4000`; Ubeeq uses `5175`/`4001`. Origins, OAuth callbacks, in-memory stores, and local media directories are isolated by edition.

The default web build is Eversally. Build the Ubeeq edition with `npm --workspace @gallery/web run build:oss`.

## Compatibility boundary

Existing code and storage identifiers such as `UbeeqCollection`, `SpacePublication`, `ubeeqCollectionId`, table keys, stack IDs, and API paths remain unchanged. They identify the underlying platform model and are not customer-facing brand copy. Renaming them would require an unnecessary data and API migration.

Site names explicitly customized by an administrator are preserved. A stored legacy default of `Ubeeq` is presented as `Eversally` when the API runs in Eversally mode.
