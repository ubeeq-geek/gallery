import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetGrid, AssetState, AuditEventList, Avatar, Badge, Banner, Breadcrumbs, Button, CheckboxField, Chip, ChipList, Cluster, CollectionSelector, Combobox, ConfirmationDialog, createProductConfig, CreatorProfileHeader, DataTable, DateField, DateTimeField, DestinationStatus, Dialog, Drawer, FilterBar, Grid, IconButton, InlineNotice, IntegrationCard, LinkButton, LoadingState, MenuButton, Page, Pagination, parseProductConfig, PolicyDisclosure, ProductConfigError, ProgressIndicator, PublicProductHeader, PublishConfirmation, RadioGroup, ResultsSummary, ReviewHoldNotice, Section, SelectField, Sidebar, Skeleton, SourceControlNotice, SplitButton, Stack, StickyActionArea, SwitchField, Tabs, TextareaField, TextField, TimeField, ToastRegion, Tooltip, WorkspaceShell, WorkCard, WorkListRow } from "../dist/index.js";

const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("operational state components expose labels, explanations, and timestamps", () => {
  const publication = render(DestinationStatus, { destination: "Eversally", state: "reconciling", explanation: "Waiting for confirmation", lastVerifiedAt: "2026-08-26T12:00:00Z" });
  assert.match(publication, /Eversally: Unknown — reconciling/);
  assert.match(publication, /Waiting for confirmation/);
  assert.match(publication, /dateTime="2026-08-26T12:00:00Z"/);
  assert.match(render(AssetState, { state: "queued", explanation: "Waiting" }), /Queued for processing/);
});

test("source notices distinguish canonical storage from external references", () => {
  assert.match(render(SourceControlNotice, { kind: "canonical" }), /Publishing changes do not remove this source Asset/);
  assert.match(render(SourceControlNotice, { kind: "external_reference", sourceName: "YouTube" }), /source file remains with YouTube/);
});

test("work cards retain separate destination states and a missing-media fallback", () => {
  const html = render(WorkCard, { title: "Work", href: "/work", visibilityLabel: "Private", assetSummary: "1 Asset", destinations: [
    { id: "home", label: "Stored in Ubeeq", state: "published", stateLabel: "Stored" },
    { id: "remote", label: "Eversally", state: "held", stateLabel: "Held" }
  ] });
  assert.match(html, /No preview available/);
  assert.match(html, /data-state="published"/);
  assert.match(html, /data-state="held"/);
});

test("integration cards render only server-permitted actions", () => {
  const html = render(IntegrationCard, { providerName: "Discord", accountScope: "Studio server", health: "degraded", healthExplanation: "Channel access changed.", capabilities: ["Announcements"], allowedActions: ["test", "reconnect"] });
  assert.match(html, /Test connection/);
  assert.match(html, /Reconnect/);
  assert.doesNotMatch(html, />Disconnect</);
  assert.match(html, /No successful sync recorded/);
});

test("collection selectors expose selection, counts, and per-option restrictions", () => {
  const html = render(CollectionSelector, { label: "Add to collections", query: "", selectedIds: ["portfolio"], collections: [
    { id: "portfolio", name: "Portfolio", workCount: 1 },
    { id: "private", name: "Private review", workCount: 12, unavailableReason: "Editor permission required" }
  ] });
  assert.match(html, /aria-label="Add to collections"/);
  assert.match(html, /checked=""/);
  assert.match(html, /1 Work/);
  assert.match(html, /Editor permission required/);
  assert.match(html, /disabled=""/);
});

test("collection selector distinguishes empty, filtered-empty, loading, and restricted states", () => {
  assert.match(render(CollectionSelector, { label: "Collections", query: "", selectedIds: [], collections: [] }), /No collections yet/);
  assert.match(render(CollectionSelector, { label: "Collections", query: "missing", selectedIds: [], collections: [{ id: "one", name: "Portfolio", workCount: 2 }] }), /No collections match your search/);
  assert.match(render(CollectionSelector, { label: "Collections", query: "", selectedIds: [], collections: [], state: "loading" }), /Loading collections/);
  assert.match(render(CollectionSelector, { label: "Collections", query: "", selectedIds: [], collections: [], state: "permission_restricted" }), /do not have permission/);
});

test("workspace shells expose product authority and one current navigation item", () => {
  const html = render(WorkspaceShell, { productId: "nightframe", displayName: "Nightframe", workspaceName: "Creator control centre", authorityLabel: "Nightframe account and policy", currentItemId: "works", items: [
    { id: "works", label: "Works", href: "/works" }, { id: "assets", label: "Assets", href: "/assets" }
  ], children: React.createElement("p", null, "Workspace content") });
  assert.match(html, /data-product-theme="nightframe"/);
  assert.match(html, /Nightframe account and policy/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /<main class="ds-workspace-main">/);
});

test("publish confirmation states source, destination, unchanged facts, and requires explicit consent", () => {
  const base = { sourceLabel: "Garden Study", sourceAuthority: "Stored in Nightframe", destinationLabel: "Eversally", destinationAuthority: "Eversally account and policy", effect: "Request publication on Eversally", unchangedFacts: ["Delete the Nightframe source", "Change unrelated Publications"], eligibilityExplanation: "The destination accepted the preflight." };
  const unconfirmed = render(PublishConfirmation, { ...base, eligibility: "eligible", confirmed: false });
  assert.match(unconfirmed, /Stored in Nightframe/);
  assert.match(unconfirmed, /Delete the Nightframe source/);
  assert.match(unconfirmed, /Publication is not complete until the destination confirms it/);
  assert.match(unconfirmed, /<button[^>]*disabled=""[^>]*><span>Request publication/);
  const confirmed = render(PublishConfirmation, { ...base, eligibility: "eligible", confirmed: true });
  assert.doesNotMatch(confirmed, /<button[^>]*disabled=""[^>]*><span>Request publication/);
});

test("publish confirmation cannot submit an ineligible destination", () => {
  const html = render(PublishConfirmation, { sourceLabel: "Work", sourceAuthority: "Stored in Ubeeq", destinationLabel: "Nightframe", destinationAuthority: "Separate service", effect: "Request publication", unchangedFacts: ["Change the source"], eligibility: "ineligible", eligibilityExplanation: "This route is not supported.", confirmed: true });
  assert.match(html, /Not eligible for this destination/);
  assert.match(html, /<button[^>]*disabled=""[^>]*><span>Request publication/);
});

test("review surfaces preserve destination scope and render only supplied public detail", () => {
  const hold = render(ReviewHoldNotice, { destinationLabel: "Eversally", publicReason: "This Publication is being reviewed.", lastUpdatedAt: "2026-08-26T12:00:00Z" });
  assert.match(hold, /Unavailable on Eversally pending review/);
  assert.match(hold, /does not delete or change the canonical Work/);
  assert.doesNotMatch(hold, /risk score|moderator note/i);
  assert.match(render(PolicyDisclosure, { title: "Destination policy", content: React.createElement("p", null, "Supplied policy copy") }), /Supplied policy copy/);
});

test("audit lists present actor category, object, destination, and permissible detail", () => {
  const html = render(AuditEventList, { events: [{ id: "event-1", timestamp: "2026-08-26T12:00:00Z", actorCategory: "service", action: "Publication held", objectLabel: "Garden Study", destinationLabel: "Eversally", permissibleDetail: "Creator notification sent" }] });
  assert.match(html, /Actor: service/);
  assert.match(html, /Garden Study · Eversally/);
  assert.match(html, /Creator notification sent/);
  assert.match(render(AuditEventList, { events: [] }), /No activity recorded/);
});

test("deployment product configuration requires safe explicit routes", () => {
  const config = createProductConfig("nightframe", { authIssuer: "https://identity.nightframe.example", publicBaseUrl: "https://nightframe.example" });
  assert.equal(config.id, "nightframe");
  assert.equal(config.theme, "nightframe");
  assert.equal(config.capabilities.federationSource, true);
  assert.throws(() => createProductConfig("ubeeq", { authIssuer: "deployment-configured" }), ProductConfigError);
  assert.throws(() => createProductConfig("eversally", { authIssuer: "http://identity.example" }), /browser-safe HTTP\(S\) URLs/);
});

test("public product configuration rejects mismatched themes and secret-shaped top-level keys", () => {
  const valid = createProductConfig("eversally", { authIssuer: "https://identity.eversally.example" });
  assert.throws(() => parseProductConfig({ ...valid, theme: "nightframe" }), /theme must match/);
  assert.throws(() => parseProductConfig({ ...valid, providerToken: "must-not-enter-browser-config" }), /privileged configuration keys/);
});

test("button controls expose loading, destructive, icon-only, and disabled-link semantics", () => {
  const loading = render(Button, { loading: true, loadingLabel: "Saving…", children: "Save" });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /disabled=""/);
  assert.match(loading, /Saving…/);
  assert.doesNotMatch(loading, />Save</);
  assert.match(render(Button, { variant: "destructive", children: "Delete" }), /ds-button--destructive/);
  assert.match(render(IconButton, { accessibleName: "Close dialog", icon: "×" }), /aria-label="Close dialog"/);
  const disabledLink = render(LinkButton, { disabled: true, href: "/publish", children: "Publish" });
  assert.match(disabledLink, /aria-disabled="true"/);
  assert.doesNotMatch(disabledLink, /href=/);
});

test("form fields associate labels, help, and server errors without colour alone", () => {
  const text = render(TextField, { id: "work-title", label: "Work title", description: "Visible at destinations.", error: "The server rejected this title.", defaultValue: "Study" });
  assert.match(text, /for="work-title"/);
  assert.match(text, /aria-invalid="true"/);
  assert.match(text, /aria-describedby="work-title-description work-title-error"/);
  assert.match(text, /role="alert"/);
  assert.match(render(TextareaField, { id: "description", label: "Description", optional: true }), /\(optional\)/);
});

test("select and checkbox fields retain native keyboard semantics and restrictions", () => {
  const select = render(SelectField, { id: "destination", label: "Destination", defaultValue: "eversally", options: [{ value: "eversally", label: "Eversally" }, { value: "nightframe", label: "Nightframe unavailable", disabled: true }] });
  assert.match(select, /<select/);
  assert.match(select, /Nightframe unavailable/);
  assert.match(select, /disabled=""/);
  const checkbox = render(CheckboxField, { id: "confirm", label: "Confirm destination", description: "Required before requesting publication.", disabled: true });
  assert.match(checkbox, /type="checkbox"/);
  assert.match(checkbox, /aria-describedby="confirm-description"/);
});

test("radio groups expose their label, one shared name, restrictions, and errors", () => {
  const html = render(RadioGroup, { label: "Visibility", description: "Applied at Eversally.", error: "Choose an available visibility.", name: "visibility", value: "public", options: [{ value: "public", label: "Public", description: "Visible to everyone." }, { value: "members", label: "Members only", disabled: true }] });
  assert.match(html, /<fieldset[^>]*aria-describedby="[^"]+-description [^"]+-error"/);
  assert.match(html, /<legend[^>]*>Visibility<\/legend>/);
  assert.equal((html.match(/name="visibility"/g) ?? []).length, 2);
  assert.match(html, /<input[^>]*checked=""[^>]*value="public"/);
  assert.match(html, /<input[^>]*disabled=""[^>]*value="members"/);
  assert.match(html, /role="alert"/);
});

test("switch fields retain native checkbox state with switch semantics", () => {
  const html = render(SwitchField, { id: "publication-updates", label: "Publication updates", description: "Notify me after destination verification.", defaultChecked: true });
  assert.match(html, /for="publication-updates"/);
  assert.match(html, /role="switch"/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /checked=""/);
  assert.match(html, /aria-describedby="publication-updates-description"/);
});

test("inline notices expose written state, non-colour icons, and appropriate announcements", () => {
  const warning = render(InlineNotice, { title: "Reconnect required", tone: "warning", children: React.createElement("p", null, "Discord authorization expired.") });
  assert.match(warning, /ds-notice--warning/);
  assert.match(warning, /aria-hidden="true">△/);
  assert.match(warning, /role="status"/);
  assert.match(warning, /aria-labelledby="[^"]+"/);
  assert.match(render(InlineNotice, { title: "Request failed", tone: "danger", children: "Try again." }), /role="alert"/);
});

test("banners and toast regions provide named dismiss controls without hiding message context", () => {
  const banner = render(Banner, { title: "Provider maintenance", tone: "unavailable", children: "Existing Works are unaffected.", onDismiss: () => undefined });
  assert.match(banner, /Provider maintenance/);
  assert.match(banner, /aria-label="Dismiss notice"/);
  const toasts = render(ToastRegion, { messages: [{ id: "saved", title: "Work saved", message: "Canonical changes are saved.", tone: "success" }, { id: "failed", title: "Remote publication failed", message: "Eversally rejected the request.", tone: "danger" }], onDismiss: () => undefined });
  assert.match(toasts, /aria-label="Notifications"/);
  assert.match(toasts, /role="status"/);
  assert.match(toasts, /role="alert"/);
  assert.match(toasts, /aria-label="Dismiss Work saved"/);
  assert.match(toasts, /Remote publication failed/);
});

test("dialogs expose labelled modal content and explicitly named close controls", () => {
  const html = render(Dialog, { open: true, title: "Publication details", description: "Destination-specific state.", closeLabel: "Close publication details", onOpenChange: () => undefined, children: "Canonical Work remains unchanged." });
  assert.match(html, /<dialog[^>]*aria-labelledby="[^"]+"[^>]*aria-describedby="[^"]+"/);
  assert.match(html, /aria-label="Close publication details"/);
  assert.match(html, /Canonical Work remains unchanged/);
});

test("confirmation dialogs state consequences and disable repeated destructive actions", () => {
  const html = render(ConfirmationDialog, { open: true, title: "Withdraw?", consequence: "Only Eversally becomes unavailable.", confirmLabel: "Withdraw", destructive: true, confirming: true, confirmingLabel: "Withdrawing…", onConfirm: () => undefined, onOpenChange: () => undefined });
  assert.match(html, /What will happen/);
  assert.match(html, /Only Eversally becomes unavailable/);
  assert.match(html, /ds-button--destructive/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Withdrawing…/);
});

test("tabs expose one selected tab, its labelled panel, and unavailable capabilities", () => {
  const html = render(Tabs, { label: "Work sections", value: "destinations", onValueChange: () => undefined, items: [{ value: "details", label: "Details", content: "Canonical metadata" }, { value: "destinations", label: "Destinations", content: "Independent states" }, { value: "restricted", label: "Nightframe", content: "Not available", disabled: true }] });
  assert.match(html, /role="tablist" aria-label="Work sections"/);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(html, /<button[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>Destinations/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Nightframe/);
  assert.match(html, /role="tabpanel"[^>]*aria-labelledby="[^"]+"[^>]*>Independent states/);
  assert.doesNotMatch(html, /Canonical metadata/);
});

test("breadcrumbs identify only the final item as the current page", () => {
  const html = render(Breadcrumbs, { items: [{ label: "Works", href: "/works" }, { label: "Study", href: "/works/study" }, { label: "Destinations" }] });
  assert.match(html, /<nav[^>]*aria-label="Breadcrumb"/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /href="\/works"/);
  assert.doesNotMatch(html, /href="[^"]+"[^>]*>Destinations/);
});

test("progress distinguishes verified percentages from indeterminate work", () => {
  const determinate = render(ProgressIndicator, { label: "Processing media", value: 175, max: 100, detail: "Not ready yet." });
  assert.match(determinate, /role="status" aria-live="polite"/);
  assert.match(determinate, /100%/);
  assert.match(determinate, /<progress[^>]*max="100"[^>]*value="100"/);
  const indeterminate = render(ProgressIndicator, { label: "Reconciling publication" });
  assert.match(indeterminate, /<progress[^>]*aria-label="Reconciling publication"[^>]*max="100"/);
  assert.doesNotMatch(indeterminate, /value=/);
  assert.doesNotMatch(indeterminate, /%/);
});

test("loading placeholders are decorative while loading context is announced", () => {
  const html = render(LoadingState, { label: "Loading Works", detail: "Checking permitted records.", rows: 2 });
  assert.match(html, /role="status" aria-live="polite" aria-label="Loading Works"/);
  assert.equal((html.match(/ds-skeleton/g) ?? []).length, 4);
  assert.match(html, /aria-hidden="true"/);
  assert.match(render(Skeleton, { shape: "circle" }), /aria-hidden="true"/);
});

test("badges and avatar fallbacks provide non-colour and textual identity cues", () => {
  const badge = render(Badge, { tone: "restricted", children: "Held" });
  assert.match(badge, /ds-badge--restricted/);
  assert.match(badge, /aria-hidden="true">◆/);
  const avatar = render(Avatar, { name: "山田 Ana" });
  assert.match(avatar, /role="img"/);
  assert.match(avatar, /aria-label="山田 Ana avatar"/);
  assert.match(avatar, />山A</);
});

test("layout primitives apply bounded semantic spacing and responsive sizing", () => {
  assert.match(render(Stack, { gap: "large", children: "Content" }), /ds-stack--gap-large/);
  assert.match(render(Cluster, { gap: "small", children: "Actions" }), /ds-cluster--gap-small/);
  assert.match(render(Grid, { minItemWidth: "18rem", children: "Cards" }), /--ds-grid-min:18rem/);
  const sidebar = render(Sidebar, { side: "end", sidebar: "Filters", children: "Results" });
  assert.match(sidebar, /ds-sidebar--end/);
  assert.ok(sidebar.indexOf("Results") < sidebar.indexOf("Filters"));
  assert.match(render(Page, { width: "wide", children: "Workspace" }), /ds-page--wide/);
});

test("sections and persistent actions expose labelled regions", () => {
  const section = render(Section, { title: "Destinations", description: "Independent publication states.", actions: "Add destination", children: "Status list" });
  assert.match(section, /<section[^>]*aria-labelledby="[^"]+"/);
  assert.match(section, /<h2 id="[^"]+">Destinations<\/h2>/);
  assert.match(section, /Independent publication states/);
  const actions = render(StickyActionArea, { label: "Work editor actions", children: "Save" });
  assert.match(actions, /role="region" aria-label="Work editor actions"/);
});

test("pagination marks one page current, bounds invalid input, and disables edges", () => {
  const middle = render(Pagination, { currentPage: 48, totalPages: 120, onPageChange: () => undefined, label: "Works pages" });
  assert.match(middle, /<nav[^>]*aria-label="Works pages"/);
  assert.equal((middle.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(middle, /aria-label="Page 48, current page"/);
  assert.match(middle, /ds-pagination__ellipsis/);
  const first = render(Pagination, { currentPage: -4, totalPages: 0, onPageChange: () => undefined });
  assert.match(first, /<button[^>]*disabled=""[^>]*aria-label="Previous page"/);
  assert.match(first, /<button[^>]*disabled=""[^>]*aria-label="Next page"/);
  assert.match(first, /Page 1, current page/);
});

test("filter bars label search regions and result summaries clamp ranges", () => {
  const html = render(FilterBar, { label: "Filter Works", search: "Search field", filters: "State filter", actions: "Clear", status: React.createElement(ResultsSummary, { from: 41, to: 80, total: 73, noun: "Works" }) });
  assert.match(html, /role="search" aria-label="Filter Works"/);
  assert.match(html, /Showing <strong>41–73<\/strong> of <strong>73<\/strong> Works/);
  assert.match(render(ResultsSummary, { from: 1, to: 20, total: 0 }), /Showing <strong>0–0<\/strong> of <strong>0<\/strong> results/);
});

test("action menus expose controlled state, permitted actions, and restrictions", () => {
  const html = render(MenuButton, { label: "Work actions", open: true, onOpenChange: () => undefined, items: [{ id: "edit", label: "Edit Work", onSelect: () => undefined }, { id: "remote", label: "Nightframe unavailable", disabled: true, onSelect: () => undefined }, { id: "delete", label: "Delete Work", destructive: true, onSelect: () => undefined }] });
  assert.match(html, /aria-haspopup="menu" aria-expanded="true"/);
  assert.match(html, /role="menu" aria-label="Work actions"/);
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 3);
  assert.match(html, /<button[^>]*role="menuitem"[^>]*disabled=""[^>]*>Nightframe unavailable/);
  assert.match(html, /ds-menu__item--destructive/);
  assert.match(render(MenuButton, { label: "Actions", open: true, onOpenChange: () => undefined, items: [] }), /No actions available/);
});

test("tooltips associate supplemental content with their focusable trigger", () => {
  const html = render(Tooltip, { content: "Verified at 12:00 UTC", children: React.createElement(Button, { "aria-describedby": "existing" }, "Details") });
  assert.match(html, /aria-describedby="existing [^"]+"/);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /Verified at 12:00 UTC/);
});

test("data tables provide semantic headers, controlled sort state, and compact alternatives", () => {
  const columns = [{ id: "work", header: "Work", sortable: true, cell: (row) => row.work }, { id: "count", header: "Assets", sortable: true, numeric: true, cell: (row) => row.count }];
  const html = render(DataTable, { caption: "Works", columns, rows: [{ id: "one", work: "Evening studies", count: 12 }], rowKey: (row) => row.id, sort: { columnId: "work", direction: "ascending" }, onSortChange: () => undefined });
  assert.match(html, /<caption>Works<\/caption>/);
  assert.match(html, /<th[^>]*scope="col"[^>]*aria-sort="ascending"/);
  assert.equal((html.match(/aria-sort=/g) ?? []).length, 1);
  assert.match(html, /ds-data-table__numeric/);
  assert.match(html, /aria-label="Works, compact view"/);
  assert.equal((html.match(/Evening studies/g) ?? []).length, 2);
});

test("empty data tables retain their caption and creator-safe recovery detail", () => {
  const html = render(DataTable, { caption: "Destinations", columns: [{ id: "name", header: "Destination", cell: (row) => row.name }], rows: [], rowKey: (row) => row.id, emptyTitle: "No destinations match", emptyDetail: "Clear filters to continue." });
  assert.match(html, /colSpan="1"/);
  assert.match(html, /No destinations match/);
  assert.match(html, /Clear filters to continue/);
});

test("comboboxes associate labels, listboxes, active options, and restrictions", () => {
  const html = render(Combobox, { id: "collection", label: "Choose collection", description: "Search permitted collections.", query: "port", open: true, onOpenChange: () => undefined, onQueryChange: () => undefined, onSelect: () => undefined, options: [{ value: "portfolio", label: "Portfolio", description: "24 Works" }, { value: "review", label: "Editorial review", disabled: true }] });
  assert.match(html, /for="collection"/);
  assert.match(html, /role="combobox"[^>]*aria-expanded="true"[^>]*aria-controls="collection-listbox"[^>]*aria-activedescendant="collection-option-0"/);
  assert.match(html, /role="listbox" aria-label="Choose collection options"/);
  assert.match(html, /role="option" aria-selected="true"/);
  assert.match(html, /role="option" aria-selected="false" aria-disabled="true"/);
  assert.match(html, /aria-describedby="collection-description"/);
});

test("comboboxes distinguish loading, empty, invalid, and disabled states", () => {
  const shared = { id: "destination", label: "Destination", query: "", open: true, onOpenChange: () => undefined, onQueryChange: () => undefined, onSelect: () => undefined, options: [] };
  assert.match(render(Combobox, { ...shared, loading: true }), /aria-busy="true"[^>]*>.*Loading options/s);
  assert.match(render(Combobox, shared), /No options match/);
  assert.match(render(Combobox, { ...shared, error: "The server rejected this selection." }), /aria-invalid="true"/);
  assert.match(render(Combobox, { ...shared, open: false, disabled: true }), /<input[^>]*disabled=""/);
});

test("drawers retain dialog semantics while exposing explicit edge placement", () => {
  const end = render(Drawer, { open: true, title: "Asset details", description: "Canonical media stored by Ubeeq.", actions: "Save metadata", onOpenChange: () => undefined, children: "Needs review" });
  assert.match(end, /<dialog[^>]*class="ds-dialog ds-dialog--drawer-end"/);
  assert.match(end, /aria-labelledby="[^"]+"[^>]*aria-describedby="[^"]+"/);
  assert.match(end, /Canonical media stored by Ubeeq/);
  assert.match(end, /ds-dialog__actions/);
  assert.match(render(Drawer, { open: true, placement: "start", title: "Filters", onOpenChange: () => undefined }), /ds-dialog--drawer-start/);
});

test("native date and time fields retain constraints and shared field messaging", () => {
  const date = render(DateField, { id: "review-date", label: "Review date", min: "2026-08-26" });
  assert.match(date, /type="date"/); assert.match(date, /min="2026-08-26"/);
  const time = render(TimeField, { id: "reminder-time", label: "Reminder time", step: 900, optional: true });
  assert.match(time, /type="time"/); assert.match(time, /step="900"/);
});

test("date-time groups label both controls, timezone context, and server errors", () => {
  const html = render(DateTimeField, { id: "publish-at", label: "Schedule publication", description: "Local destination time.", timezone: "Europe/London (UTC+01:00)", required: true, error: "The selected time has already passed.", dateInput: { defaultValue: "2026-08-25" }, timeInput: { defaultValue: "09:00" } });
  assert.match(html, /<fieldset[^>]*aria-describedby="publish-at-description publish-at-error"[^>]*aria-invalid="true"/);
  assert.match(html, /for="publish-at-date"/);
  assert.match(html, /for="publish-at-time"/);
  assert.equal((html.match(/required=""/g) ?? []).length, 2);
  assert.match(html, /Time zone: <strong>Europe\/London \(UTC\+01:00\)<\/strong>/);
  assert.match(html, /role="alert"/);
});

test("split buttons keep the primary action separate from permitted alternatives", () => {
  const html = render(SplitButton, { primaryLabel: "Publish to Eversally", onPrimaryAction: () => undefined, menuLabel: "Other publication actions", open: true, onOpenChange: () => undefined, items: [{ id: "schedule", label: "Schedule publication", onSelect: () => undefined }, { id: "nightframe", label: "Nightframe unavailable", disabled: true, onSelect: () => undefined }] });
  assert.match(html, /role="group" aria-label="Other publication actions"/);
  assert.match(html, />Publish to Eversally<\/span>/);
  assert.match(html, /aria-haspopup="menu" aria-expanded="true"/);
  assert.match(html, /Schedule publication/);
  assert.match(html, /<button[^>]*role="menuitem"[^>]*disabled=""[^>]*>Nightframe unavailable/);
});

test("busy split buttons prevent repeated primary and alternative actions", () => {
  const html = render(SplitButton, { primaryLabel: "Publish", onPrimaryAction: () => undefined, menuLabel: "Other actions", items: [], open: false, onOpenChange: () => undefined, loading: true, loadingLabel: "Submitting request…" });
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Submitting request…/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
});

test("chips expose explicitly named removal without treating metadata as status", () => {
  const removable = render(Chip, { label: "Portfolio", onRemove: () => undefined, removeLabel: "Remove Portfolio" });
  assert.match(removable, /class="ds-chip"/);
  assert.match(removable, /aria-label="Remove Portfolio"/);
  assert.match(removable, /aria-hidden="true">×/);
  assert.doesNotMatch(render(Chip, { label: "Photography" }), /<button/);
  const disabled = render(Chip, { label: "Editorial review", disabled: true, onRemove: () => undefined, removeLabel: "Remove Editorial review" });
  assert.match(disabled, /ds-chip--disabled/);
  assert.match(disabled, /disabled=""/);
});

test("chip lists provide a named semantic list for metadata associations", () => {
  const html = render(ChipList, { label: "Selected collections", children: [React.createElement(Chip, { key: "one", label: "Portfolio" }), React.createElement(Chip, { key: "two", label: "Night studies" })] });
  assert.match(html, /<ul[^>]*aria-label="Selected collections"/);
  assert.equal((html.match(/<li/g) ?? []).length, 2);
});

test("work list rows retain identity, timestamps, actions, and independent destination states", () => {
  const html = render(WorkListRow, { title: "Evening studies", href: "/works/evening", visibilityLabel: "Private", assetSummary: "4 Assets", lastUpdatedAt: "2026-08-26T12:00:00Z", lastUpdatedLabel: "26 Aug 2026", actions: "Review", destinations: [{ id: "home", label: "Stored in Ubeeq", state: "published", stateLabel: "Stored" }, { id: "eversally", label: "Eversally", state: "held", stateLabel: "Held" }] });
  assert.match(html, /href="\/works\/evening"/);
  assert.match(html, /dateTime="2026-08-26T12:00:00Z"/);
  assert.match(html, /aria-label="Evening studies destination summary"/);
  assert.match(html, /data-state="published"/);
  assert.match(html, /data-state="held"/);
  assert.match(html, /aria-label="Evening studies actions"/);
});

test("work list rows expose a non-image fallback without meaningless alt text", () => {
  const html = render(WorkListRow, { title: "No preview", href: "/works/no-preview", visibilityLabel: "Private", assetSummary: "No Assets", destinations: [] });
  assert.match(html, /ds-work-row__media/);
  assert.match(html, /aria-hidden="true">□/);
  assert.doesNotMatch(html, /<img/);
});

test("asset grids distinguish lifecycle, canonical source, and external references", () => {
  const html = render(AssetGrid, { label: "Work Assets", items: [{ id: "canonical", title: "Primary image", href: "/assets/one", state: "ready", mediaSummary: "JPEG", sourceKind: "canonical", sourceLabel: "Canonical Asset in Ubeeq" }, { id: "external", title: "Remote video", href: "/assets/two", state: "unavailable_pending_review", mediaSummary: "External reference", sourceKind: "external_reference", sourceLabel: "Source remains with YouTube", actions: "Review" }] });
  assert.match(html, /aria-label="Work Assets"/);
  assert.match(html, /aria-label="Primary image: Ready"/);
  assert.match(html, /Canonical Asset in Ubeeq/);
  assert.match(html, /aria-label="Remote video: Unavailable pending review"/);
  assert.match(html, /Source remains with YouTube/);
  assert.match(html, /aria-label="Remote video actions"/);
});

test("asset grids provide explicit missing-preview and empty states", () => {
  const item = render(AssetGrid, { items: [{ id: "one", title: "No preview", href: "/asset", state: "checking", mediaSummary: "Metadata pending", sourceKind: "canonical", sourceLabel: "Canonical Asset" }] });
  assert.match(item, /No preview available/);
  const empty = render(AssetGrid, { items: [], emptyTitle: "No Assets available", emptyDetail: "Upload an Asset if permitted." });
  assert.match(empty, /aria-label="Assets"/);
  assert.match(empty, /No Assets available/);
  assert.match(empty, /Upload an Asset if permitted/);
});

test("public product headers identify the host and one current destination", () => {
  const html = render(PublicProductHeader, { productId: "eversally", displayName: "Eversally", authorityLabel: "Eversally service and policy", currentItemId: "discover", navigation: [{ id: "discover", label: "Discover", href: "/discover" }, { id: "challenges", label: "Challenges", href: "/challenges" }], actions: "Sign in" });
  assert.match(html, /data-product="eversally"/);
  assert.match(html, /Eversally service and policy/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Eversally account actions"/);
});

test("creator profiles distinguish the page host from the creator home service", () => {
  const html = render(CreatorProfileHeader, { creatorName: "Aiko 山田", profileLabel: "Space", hostService: "Eversally", homeService: "Nightframe", description: "Light and motion studies.", metadata: "12 Works", actions: "Follow" });
  assert.match(html, /Space on Eversally/);
  assert.match(html, /Home service: <strong>Nightframe<\/strong>/);
  assert.match(html, /presented under Eversally’s account and policy authority/);
  assert.match(html, /aria-label="Aiko 山田 profile actions"/);
  assert.match(html, /aria-label="Aiko 山田 avatar"/);
});
