import { Link } from 'react-router-dom';
import type { DensityViewport, DiscoveryFilterSection, FeedDensity, ManagedCreator } from '../domainTypes';
import { heavyTopicLabels } from '../discoveryUtils';

type CompactTab = {
  section: DiscoveryFilterSection;
  label: string;
};

type DiscoveryControlsPanelProps = {
  showCompactDiscoveryDock: boolean;
  densityViewport: DensityViewport;
  compactFiltersOpen: boolean;
  compactTabs: CompactTab[];
  compactFilterSection: DiscoveryFilterSection;
  compactHeavyTopicsExpanded: boolean;
  trendingPeriod: 'hourly' | 'daily';
  feedDensity: FeedDensity;
  densityOptions: FeedDensity[];
  densitySliderValue: number;
  isDensityTransitioning: boolean;
  densityLabel: Record<FeedDensity, string>;
  hideHeavyTopics: boolean;
  hidePoliticsPublicAffairs: boolean;
  hideCrimeDisastersTragedy: boolean;
  showImageMedia: boolean;
  showVideoMedia: boolean;
  showPostMedia: boolean;
  showAudioMedia: boolean;
  heavyTopicsExpanded: boolean;
  discoverySearch: string;
  currentUserPresent: boolean;
  favoriteIdentity: string;
  managedArtists: ManagedCreator[];
  discoveryFilterPanelRef: React.MutableRefObject<HTMLDivElement | null>;
  discoverySearchInputRef: React.MutableRefObject<HTMLInputElement | null>;
  compactSearchInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onCloseCompactFilters: () => void;
  onCompactSectionChange: (section: DiscoveryFilterSection) => void;
  onCompactHeavyTopicsExpandedChange: (expanded: boolean) => void;
  onTrendingPeriodChange: (period: 'hourly' | 'daily') => void;
  onHideAllHeavyTopicsChange: (enabled: boolean) => void;
  onHidePoliticsPublicAffairsChange: (enabled: boolean) => void;
  onHideCrimeDisastersTragedyChange: (enabled: boolean) => void;
  onShowImageMediaChange: (enabled: boolean) => void;
  onShowVideoMediaChange: (enabled: boolean) => void;
  onShowPostMediaChange: (enabled: boolean) => void;
  onShowAudioMediaChange: (enabled: boolean) => void;
  onHeavyTopicsExpandedChange: (expanded: boolean) => void;
  onDensitySliderChange: (value: number) => void;
  onDensityOptionChange: (density: FeedDensity) => void;
  onDiscoverySearchChange: (value: string) => void;
  onFavoriteIdentityChange: (value: string) => void;
};

export default function DiscoveryControlsPanel({
  showCompactDiscoveryDock,
  densityViewport,
  compactFiltersOpen,
  compactTabs,
  compactFilterSection,
  compactHeavyTopicsExpanded,
  trendingPeriod,
  feedDensity,
  densityOptions,
  densitySliderValue,
  isDensityTransitioning,
  densityLabel,
  hideHeavyTopics,
  hidePoliticsPublicAffairs,
  hideCrimeDisastersTragedy,
  showImageMedia,
  showVideoMedia,
  showPostMedia,
  showAudioMedia,
  heavyTopicsExpanded,
  discoverySearch,
  currentUserPresent,
  favoriteIdentity,
  managedArtists,
  discoveryFilterPanelRef,
  discoverySearchInputRef,
  compactSearchInputRef,
  onCloseCompactFilters,
  onCompactSectionChange,
  onCompactHeavyTopicsExpandedChange,
  onTrendingPeriodChange,
  onHideAllHeavyTopicsChange,
  onHidePoliticsPublicAffairsChange,
  onHideCrimeDisastersTragedyChange,
  onShowImageMediaChange,
  onShowVideoMediaChange,
  onShowPostMediaChange,
  onShowAudioMediaChange,
  onHeavyTopicsExpandedChange,
  onDensitySliderChange,
  onDensityOptionChange,
  onDiscoverySearchChange,
  onFavoriteIdentityChange
}: DiscoveryControlsPanelProps) {
  const renderCompactFilterBody = () => {
    if (compactFilterSection === 'period') {
      return (
        <div className="discovery-compact-section discovery-compact-period-section">
          <div className="discovery-filter-label">Trending period</div>
          <div className="discovery-trending-filter">
            <button
              className={`discovery-pill-btn${trendingPeriod === 'hourly' ? ' is-active' : ''}`}
              onClick={() => onTrendingPeriodChange('hourly')}
            >
              Hourly
            </button>
            <button
              className={`discovery-pill-btn${trendingPeriod === 'daily' ? ' is-active' : ''}`}
              onClick={() => onTrendingPeriodChange('daily')}
            >
              Daily
            </button>
            <Link className="discovery-pill-btn no-underline" to="/trending" onClick={onCloseCompactFilters}>View all</Link>
          </div>
        </div>
      );
    }

    if (compactFilterSection === 'media') {
      return (
        <div className="discovery-compact-section discovery-compact-period-section">
          <div className="discovery-filter-label">Media types</div>
          <div className="discovery-trending-filter">
            <button className={`discovery-pill-btn${showImageMedia ? ' is-active' : ''}`} onClick={() => onShowImageMediaChange(!showImageMedia)}>
              🖼 Images
            </button>
            <button className={`discovery-pill-btn${showVideoMedia ? ' is-active' : ''}`} onClick={() => onShowVideoMediaChange(!showVideoMedia)}>
              🎬 Videos
            </button>
            <button className={`discovery-pill-btn${showPostMedia ? ' is-active' : ''}`} onClick={() => onShowPostMediaChange(!showPostMedia)}>
              📝 Stories
            </button>
            <button className={`discovery-pill-btn${showAudioMedia ? ' is-active' : ''}`} onClick={() => onShowAudioMediaChange(!showAudioMedia)}>
              ♪ Audio
            </button>
          </div>
        </div>
      );
    }

    if (compactFilterSection === 'heavy') {
      return (
        <div className="discovery-heavy-card">
          <div className="discovery-heavy-head">
            <label className="discovery-heavy-row is-primary">
              <input
                type="checkbox"
                checked={hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy)}
                onChange={(e) => onHideAllHeavyTopicsChange(e.target.checked)}
              />
              <span>Hide all heavy topics</span>
            </label>
            <button
              type="button"
              className={`discovery-heavy-toggle${compactHeavyTopicsExpanded ? ' is-expanded' : ''}`}
              onClick={() => onCompactHeavyTopicsExpandedChange(!compactHeavyTopicsExpanded)}
              aria-label={compactHeavyTopicsExpanded ? 'Collapse heavy topics options' : 'Expand heavy topics options'}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M6 12L10 8L14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {compactHeavyTopicsExpanded && (
            <div className="discovery-heavy-body">
              <label className="discovery-heavy-row">
                <input
                  type="checkbox"
                  checked={hidePoliticsPublicAffairs}
                  onChange={(e) => onHidePoliticsPublicAffairsChange(e.target.checked)}
                />
                <span>{heavyTopicLabels['politics-public-affairs']}</span>
              </label>
              <label className="discovery-heavy-row">
                <input
                  type="checkbox"
                  checked={hideCrimeDisastersTragedy}
                  onChange={(e) => onHideCrimeDisastersTragedyChange(e.target.checked)}
                />
                <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
              </label>
            </div>
          )}
        </div>
      );
    }

    if (compactFilterSection === 'density') {
      return (
        <div className="discovery-density-card">
          <div className="discovery-density-head">
            <span>Feed density</span>
            <strong>{densityLabel[feedDensity]}</strong>
          </div>
          {densityViewport === 'desktop' && (
            <input
              className="discovery-density-range"
              type="range"
              min={0}
              max={2}
              step={1}
              value={densitySliderValue}
              disabled={isDensityTransitioning}
              onChange={(e) => onDensitySliderChange(Number(e.target.value))}
            />
          )}
          <div className={`discovery-density-options${densityOptions.length === 2 ? ' is-two' : ''}`}>
            {densityOptions.map((option) => (
              <button
                key={`compact-density-option-${option}`}
                type="button"
                disabled={isDensityTransitioning}
                className={feedDensity === option ? 'is-active' : ''}
                onClick={() => onDensityOptionChange(option)}
              >
                {densityLabel[option]}
              </button>
            ))}
          </div>          
        </div>
      );
    }

    return (
      <div className="discovery-search-card is-compact">
        <div className="discovery-filter-label">Search</div>
        <div className="discovery-search-input-wrap">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M9 4.25a4.75 4.75 0 103.78 7.64l2.16 2.16a.75.75 0 101.06-1.06l-2.16-2.16A4.75 4.75 0 009 4.25z" fill="currentColor" />
          </svg>
          <input
            ref={compactSearchInputRef}
            type="text"
            value={discoverySearch}
            onChange={(e) => onDiscoverySearchChange(e.target.value)}
            placeholder="Search titles, creators, groupings, tags..."
          />
        </div>
      </div>
    );
  };

  return (
    <>
      {showCompactDiscoveryDock && densityViewport !== 'mobile' && compactFiltersOpen && (
        <div className="discovery-compact-popover-layer" onClick={onCloseCompactFilters}>
          <div className="discovery-compact-popover" role="dialog" aria-label="Discovery filters" onClick={(e) => e.stopPropagation()}>
            <div className="discovery-compact-popover-toolbar">
              <button type="button" className="discovery-compact-close-btn" onClick={onCloseCompactFilters} aria-label="Close discovery filters">
                ✕
              </button>
            </div>
            <div className="discovery-compact-tabs discovery-compact-tabs-tablet">
              {compactTabs.map((tab) => (
                <button
                  key={`compact-tab-desktop-${tab.section}`}
                  type="button"
                  className={`topbar-discovery-chip topbar-discovery-chip-interactive${compactFilterSection === tab.section ? ' is-active' : ''}`}
                  onClick={() => onCompactSectionChange(tab.section)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="discovery-compact-body">{renderCompactFilterBody()}</div>
          </div>
        </div>
      )}

      {showCompactDiscoveryDock && densityViewport === 'mobile' && compactFiltersOpen && (
        <div className="discovery-compact-sheet-layer" onClick={onCloseCompactFilters}>
          <div className="discovery-compact-sheet" role="dialog" aria-label="Discovery filters" onClick={(e) => e.stopPropagation()}>
            <div className="discovery-compact-sheet-handle" />
            <div className="discovery-compact-header">
              <div className="discovery-filter-label">Discovery controls</div>
              <button type="button" className="discovery-compact-close-btn" onClick={onCloseCompactFilters} aria-label="Close discovery filters">
                ✕
              </button>
            </div>
            <div className="discovery-compact-tabs">
              {compactTabs.map((tab) => (
                <button
                  key={`compact-tab-mobile-${tab.section}`}
                  type="button"
                  className={`topbar-discovery-chip topbar-discovery-chip-interactive${compactFilterSection === tab.section ? ' is-active' : ''}`}
                  onClick={() => onCompactSectionChange(tab.section)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="discovery-compact-body">{renderCompactFilterBody()}</div>
          </div>
        </div>
      )}

      <div id="discovery-filter-panel" ref={discoveryFilterPanelRef} className="discovery-filter-shell">
        <div className="discovery-filter-grid">
          <div className="discovery-filter-left">
              <div>
                <div className="discovery-filter-label">Trending period</div>
                <div className="discovery-trending-filter">
                <button
                  className={`discovery-pill-btn${trendingPeriod === 'hourly' ? ' is-active' : ''}`}
                  onClick={() => onTrendingPeriodChange('hourly')}
                >
                  Hourly
                </button>
                <button
                  className={`discovery-pill-btn${trendingPeriod === 'daily' ? ' is-active' : ''}`}
                  onClick={() => onTrendingPeriodChange('daily')}
                >
                  Daily
                </button>
                  <Link className="discovery-pill-btn no-underline" to="/trending">View all</Link>
                </div>
              </div>

              <div>
                <div className="discovery-filter-label">Media types</div>
                <div className="discovery-trending-filter">
                  <button className={`discovery-pill-btn${showImageMedia ? ' is-active' : ''}`} onClick={() => onShowImageMediaChange(!showImageMedia)}>
                    🖼 Images
                  </button>
                  <button className={`discovery-pill-btn${showVideoMedia ? ' is-active' : ''}`} onClick={() => onShowVideoMediaChange(!showVideoMedia)}>
                    🎬 Videos
                  </button>
                  <button className={`discovery-pill-btn${showPostMedia ? ' is-active' : ''}`} onClick={() => onShowPostMediaChange(!showPostMedia)}>
                    📝 Stories
                  </button>
                  <button className={`discovery-pill-btn${showAudioMedia ? ' is-active' : ''}`} onClick={() => onShowAudioMediaChange(!showAudioMedia)}>
                    ♪ Audio
                  </button>
                </div>
              </div>

            <div className="discovery-heavy-card">
              <div className="discovery-heavy-head">
                <label className="discovery-heavy-row is-primary">
                  <input
                    type="checkbox"
                    checked={hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy)}
                    onChange={(e) => onHideAllHeavyTopicsChange(e.target.checked)}
                  />
                  <span>Hide all heavy topics</span>
                </label>
                <button
                  type="button"
                  className={`discovery-heavy-toggle${heavyTopicsExpanded ? ' is-expanded' : ''}`}
                  onClick={() => onHeavyTopicsExpandedChange(!heavyTopicsExpanded)}
                  aria-label={heavyTopicsExpanded ? 'Collapse heavy topics options' : 'Expand heavy topics options'}
                >
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M6 12L10 8L14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
              {heavyTopicsExpanded && (
                <div className="discovery-heavy-body">
                  <label className="discovery-heavy-row">
                    <input
                      type="checkbox"
                      checked={hidePoliticsPublicAffairs}
                      onChange={(e) => onHidePoliticsPublicAffairsChange(e.target.checked)}
                    />
                    <span>{heavyTopicLabels['politics-public-affairs']}</span>
                  </label>
                  <label className="discovery-heavy-row">
                    <input
                      type="checkbox"
                      checked={hideCrimeDisastersTragedy}
                      onChange={(e) => onHideCrimeDisastersTragedyChange(e.target.checked)}
                    />
                    <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
                  </label>
                </div>
              )}
            </div>
          </div>

          <div className="discovery-filter-right">
            <div className="discovery-density-card">
              <div className="discovery-density-head">
                <span>Feed density</span>
                <strong>{densityLabel[feedDensity]}</strong>
              </div>
              {densityViewport === 'desktop' && (
                <input
                  className="discovery-density-range"
                  type="range"
                  min={0}
                  max={2}
                  step={1}
                  value={densitySliderValue}
                  disabled={isDensityTransitioning}
                  onChange={(e) => onDensitySliderChange(Number(e.target.value))}
                />
              )}
              <div className={`discovery-density-options${densityOptions.length === 2 ? ' is-two' : ''}`}>
                {densityOptions.map((option) => (
                  <button
                    key={`density-option-${option}`}
                    type="button"
                    disabled={isDensityTransitioning}
                    className={feedDensity === option ? 'is-active' : ''}
                    onClick={() => onDensityOptionChange(option)}
                  >
                    {densityLabel[option]}
                  </button>
                ))}
              </div>              
            </div>

            <div className="discovery-search-card">
              <div className="discovery-filter-label">Search</div>
              <div className="discovery-search-input-wrap">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M9 4.25a4.75 4.75 0 103.78 7.64l2.16 2.16a.75.75 0 101.06-1.06l-2.16-2.16A4.75 4.75 0 009 4.25z" fill="currentColor" />
                </svg>
                <input
                  ref={discoverySearchInputRef}
                  type="text"
                  value={discoverySearch}
                  onChange={(e) => onDiscoverySearchChange(e.target.value)}
                  placeholder="Search titles, creators, groupings, tags..."
                />
              </div>
              {currentUserPresent && (
                <div className="discovery-favorite-context">
                  <label className="small">Favorite as</label>
                  <select
                    className="settings-select"
                    value={favoriteIdentity}
                    onChange={(e) => onFavoriteIdentityChange(e.target.value)}
                  >
                    <option value="user">User Profile</option>
                    {managedArtists.map((creator) => (
                      <option key={`home-favorite-${creator.creatorId}`} value={`creator:${creator.creatorId}`}>
                        Creator: {creator.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
