import type { ComponentType } from 'react';
import type { IconName } from '../../components/Icon.tsx';
import { AboutSection } from './AboutSection.tsx';
import { AccountSection } from './AccountSection.tsx';
import { GeneralSection } from './GeneralSection.tsx';
import { LicencesSection } from './LicencesSection.tsx';
import { PluginsSection } from './PluginsSection.tsx';
import { QueueSection } from './QueueSection.tsx';
import { RecycleSection } from './RecycleSection.tsx';
import { TokensSection } from './TokensSection.tsx';

/** A page inside a section (`/settings/<section>/<id>`): the sub-nav keeps its section current. */
export interface SettingsSubPage {
  id: string;
  title: string;
  Component: ComponentType;
}

/** One Settings section: its URL segment (`/settings/<id>`), its title (the h2) and its body. */
export interface SettingsSection {
  id: string;
  title: string;
  icon: IconName;
  Component: ComponentType;
  subs?: readonly SettingsSubPage[] | undefined;
}

/**
 * The sections, in the design's order: General, Queue and engine, Recycle, Plugins, Account,
 * API tokens, About. `/settings` opens the first one.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'general', title: 'General', icon: 'settings', Component: GeneralSection },
  { id: 'queue', title: 'Queue and engine', icon: 'jobs', Component: QueueSection },
  { id: 'recycle', title: 'Recycle', icon: 'trash', Component: RecycleSection },
  { id: 'plugins', title: 'Plugins', icon: 'plugins', Component: PluginsSection },
  { id: 'account', title: 'Account', icon: 'user', Component: AccountSection },
  { id: 'api-tokens', title: 'API tokens', icon: 'key', Component: TokensSection },
  {
    id: 'about',
    title: 'About',
    icon: 'info',
    Component: AboutSection,
    subs: [{ id: 'licences', title: 'Open-source licences', Component: LicencesSection }],
  },
];
