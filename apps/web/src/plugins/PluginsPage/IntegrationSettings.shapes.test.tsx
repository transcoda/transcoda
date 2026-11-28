import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  plugins: {
    get: vi.fn(),
    settingsGet: vi.fn(),
    settingsSave: vi.fn(),
    settingsTest: vi.fn(),
    testMapping: vi.fn(),
  },
}));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { serviceDetail } from '../../testing/fixtures/plugins.ts';
import { renderAt } from '../../testing/render.tsx';
import { IntegrationSettings } from './IntegrationSettings.tsx';

/**
 * An integration whose settings use the shapes docs/settings-forms.md lists, as zod 4's
 * `toJSONSchema(..., { io: 'input' })` writes them (see schema-fields.shapes.test.ts).
 */
const SCHEMA = {
  type: 'object',
  properties: {
    // url()
    url: { type: 'string', format: 'uri', description: 'Server URL', 'x-transcoda': 'url' },
    // z.string().nullable().default(null)
    folder: { default: null, type: ['string', 'null'], description: 'Drop folder' },
    // z.union([z.literal('fast'), z.literal('slow')]).default('fast')
    speed: {
      default: 'fast',
      anyOf: [
        { type: 'string', const: 'fast' },
        { type: 'string', const: 'slow' },
      ],
      description: 'Speed',
    },
    // z.boolean().default(false)
    notify: { type: 'boolean', default: false, description: 'Send a message' },
    // z.string().optional().meta({ 'x-transcoda-show-when': { notify: true } })
    channel: {
      type: 'string',
      description: 'Channel',
      'x-transcoda-show-when': { notify: true },
    },
    // z.array(z.string()).default([])
    tags: { type: 'array', items: { type: 'string' }, default: [], description: 'Tags' },
  },
  required: ['url'],
} as const;

const stored = {
  settings: { url: 'https://svc.test', folder: null, tags: ['one', 'two'] },
  lastTest: null,
  needsReview: null,
};

beforeEach(() => {
  mocks.plugins.get.mockReset().mockResolvedValue(
    serviceDetail({
      integration: {
        id: 'service',
        title: 'Service',
        settingsSchema: SCHEMA as never,
        requires: null,
      },
    }),
  );
  mocks.plugins.settingsGet.mockReset().mockResolvedValue(stored);
  mocks.plugins.settingsSave.mockReset().mockResolvedValue(stored);
  mocks.plugins.settingsTest.mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
  mocks.plugins.testMapping.mockReset();
});
afterEach(cleanup);

async function open() {
  renderAt('/plugins', <IntegrationSettings name="service" />);
  await screen.findByLabelText('Server URL');
}

describe('IntegrationSettings with the supported shapes', () => {
  it('a nullable setting is a text input, not raw JSON, and a stored null reads as not set', async () => {
    await open();
    const folder = screen.getByLabelText('Drop folder') as HTMLInputElement;
    expect(folder.tagName).toBe('INPUT');
    expect(folder.value).toBe('');
    const frame = folder.closest('[data-field]') as HTMLElement;
    expect(within(frame).getByText('not set')).toBeTruthy();
    fireEvent.change(folder, { target: { value: '/drop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }));
    await vi.waitFor(() => expect(mocks.plugins.settingsSave).toHaveBeenCalled());
    expect(mocks.plugins.settingsSave.mock.calls[0]?.[0].settings).toMatchObject({
      folder: '/drop',
    });
  });

  it('a union of string literals is a segmented choice', async () => {
    await open();
    const group = screen.getByRole('radiogroup', { name: 'Speed' });
    expect(within(group).getByRole('radio', { name: 'fast' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('a setting with show-when appears only while the other setting has the value', async () => {
    await open();
    expect(screen.queryByLabelText('Channel')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Send a message' }));
    expect(screen.getByLabelText('Channel')).toBeTruthy();
  });

  it("the server's issue on a nested path shows under its top-level field", async () => {
    mocks.plugins.settingsSave.mockRejectedValueOnce(
      new ORPCError('PLUGIN_SETTINGS_INVALID', {
        defined: true,
        status: 422,
        message: 'The settings are not valid',
        data: { issues: [{ path: 'tags.1', message: 'Too long', missing: false }] },
      }),
    );
    await open();
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://other.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }));
    const issue = await screen.findByText('Too long');
    expect(issue.closest('[data-field]')?.getAttribute('data-field')).toBe('tags');
  });
});
