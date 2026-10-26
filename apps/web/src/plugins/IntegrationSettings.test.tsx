import { ORPCError } from '@orpc/client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return { api: mocks, isDefinedError: orpc.isDefinedError, safe: orpc.safe };
});

import { SERVICE_SCHEMA, serviceDetail } from '../test/fixtures/plugins.ts';
import { renderAt } from '../test/render.tsx';
import {
  IntegrationSettings,
  payloadOf,
  settingsDirty,
  testResultText,
} from './IntegrationSettings.tsx';

const stored = {
  settings: {
    url: 'https://svc.test',
    apiKey: { set: true },
    pathMappings: [],
    insecureTls: false,
  },
  lastTest: null,
  needsReview: null,
};

beforeEach(() => {
  mocks.plugins.get.mockReset().mockResolvedValue(serviceDetail());
  mocks.plugins.settingsGet.mockReset().mockResolvedValue(stored);
  mocks.plugins.settingsSave.mockReset().mockResolvedValue(stored);
  mocks.plugins.settingsTest.mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
  mocks.plugins.testMapping.mockReset();
});
afterEach(cleanup);

const saveButton = () => screen.getByRole('button', { name: 'Save and test' }) as HTMLButtonElement;

/** Swaps the stored API key's "Stored" line for an input, as the Replace button does. */
function replaceKey() {
  fireEvent.click(screen.getByRole('button', { name: 'Replace API key' }));
  return screen.getByLabelText('API key') as HTMLInputElement;
}

async function open() {
  renderAt('/plugins', <IntegrationSettings name="service" />);
  await screen.findByLabelText('Server URL');
}

describe('IntegrationSettings', () => {
  it('shows a stored secret as Stored with its last four, never the value, and Replace swaps in an empty input', async () => {
    mocks.plugins.settingsGet.mockResolvedValue({
      ...stored,
      settings: { ...stored.settings, apiKey: { set: true, endsWith: '4f2a' } },
    });
    await open();
    const shown = screen.getByLabelText('API key') as HTMLInputElement;
    expect(shown.readOnly).toBe(true);
    expect(shown.value).toBe('Stored, ends in 4f2a');
    const key = replaceKey();
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(key.placeholder).toBe('Saved; type to replace');
    expect(document.activeElement).toBe(key);
    cleanup();
    // Without a hint (a short secret), only "Stored".
    mocks.plugins.settingsGet.mockResolvedValue(stored);
    await open();
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('Stored');
  });

  it('leaves a stored secret out of the payload until typed over', async () => {
    await open();
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).inputMode).toBe('url');

    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://svc2.test' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.plugins.settingsSave).toHaveBeenCalledTimes(1));
    const sent = mocks.plugins.settingsSave.mock.calls[0]?.[0];
    expect(sent).toEqual({
      name: 'service',
      settings: { url: 'https://svc2.test', pathMappings: [], insecureTls: false },
    });
    expect(JSON.stringify(sent)).not.toContain('apiKey');
    cleanup();

    await open();
    fireEvent.change(replaceKey(), { target: { value: 'new-key' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.plugins.settingsSave).toHaveBeenCalledTimes(2));
    expect(mocks.plugins.settingsSave.mock.calls[1]?.[0].settings.apiKey).toBe('new-key');
  });

  it('payloadOf drops unset values and untouched secret markers', () => {
    expect(
      payloadOf({
        a: 'x',
        b: undefined,
        c: { set: true },
        d: false,
        e: [{ remote: '/a', local: '/b' }],
      }),
    ).toEqual({ a: 'x', d: false, e: [{ remote: '/a', local: '/b' }] });
  });

  it('Test connection sends the current form values and shows the message, version and warnings', async () => {
    mocks.plugins.settingsTest.mockResolvedValue({
      ok: true,
      message: 'Connected to Service',
      version: '4.0.20',
      warnings: ['Unmonitor deleted is on'],
    });
    await open();
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://other.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection for service' }));
    const result = await screen.findByText('Connected to Service');
    expect(result.closest('[role="status"]')?.textContent).toContain('4.0.20');
    expect(screen.getByText('Unmonitor deleted is on')).toBeTruthy();
    expect(mocks.plugins.settingsTest).toHaveBeenCalledWith({
      name: 'service',
      settings: { url: 'https://other.test', pathMappings: [], insecureTls: false },
    });
  });

  it("a failed test shows its message; the server's field issues land under the field", async () => {
    mocks.plugins.settingsTest.mockResolvedValueOnce({
      ok: false,
      kind: 'unauthorized',
      message: 'The API key was refused',
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection for service' }));
    expect(await screen.findByText('The API key was refused')).toBeTruthy();

    mocks.plugins.settingsSave.mockRejectedValueOnce(
      new ORPCError('PLUGIN_SETTINGS_INVALID', {
        defined: true,
        status: 422,
        message: 'The settings are not valid',
        data: { issues: [{ path: 'url', message: 'Not a valid URL', missing: false }] },
      }),
    );
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'svc' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText('Not a valid URL')).toBeTruthy();
  });

  it('a required field left empty says Required before anything is sent', async () => {
    mocks.plugins.settingsGet.mockResolvedValue({
      ...stored,
      settings: { pathMappings: [], insecureTls: false },
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection for service' }));
    expect((await screen.findAllByText('Required')).length).toBe(2);
    expect(mocks.plugins.settingsTest).not.toHaveBeenCalled();
  });

  it('settings that need review say so; the form still works', async () => {
    mocks.plugins.settingsGet.mockResolvedValue({
      ...stored,
      needsReview: 'apiKey: Required',
    });
    await open();
    expect(screen.getByText('Settings need review: apiKey: Required')).toBeTruthy();
  });

  it('path mapping rows add and remove, and Test mapping shows the server message', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    fireEvent.change(screen.getByLabelText('Remote path 1'), { target: { value: '/shows' } });
    fireEvent.change(screen.getByLabelText('Local path 1'), { target: { value: '/data/shows' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    expect(screen.getByLabelText('Remote path 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping 2' }));
    expect(screen.queryByLabelText('Remote path 2')).toBeNull();

    mocks.plugins.testMapping.mockResolvedValue({
      ok: true,
      message: '/data/shows is inside the library /data',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test mapping 1' }));
    expect(await screen.findByText('/data/shows is inside the library /data')).toBeTruthy();
    expect(mocks.plugins.testMapping).toHaveBeenCalledWith({
      name: 'service',
      mapping: { remote: '/shows', local: '/data/shows' },
    });

    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.plugins.settingsSave).toHaveBeenCalled());
    expect(mocks.plugins.settingsSave.mock.calls[0]?.[0].settings.pathMappings).toEqual([
      { remote: '/shows', local: '/data/shows' },
    ]);
  });

  it('path mappings and insecure TLS sit under a closed Advanced, after the connection fields', async () => {
    await open();
    const toggle = screen.getByRole('button', { name: 'Advanced' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('textbox', { name: 'Server URL' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Allow insecure TLS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add mapping' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('switch', { name: 'Allow insecure TLS' }));
    expect(toggle.textContent).toContain('1 changed');
  });

  it('the insecure TLS switch carries its help text', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const row = screen
      .getByText('Accept self-signed certificates for this service')
      .closest('.tc-field');
    expect(within(row as HTMLElement).getByRole('switch')).toBeTruthy();
  });

  it('a stored optional secret shows neither Clear nor "not set"; emptying typed text keeps the stored value', async () => {
    mocks.plugins.get.mockResolvedValue(
      serviceDetail({
        integration: {
          id: 'service',
          title: 'Service',
          settingsSchema: { ...SERVICE_SCHEMA, required: ['url'] } as never,
          requires: null,
        },
      }),
    );
    await open();
    const key = replaceKey();
    const field = key.closest('.tc-field') as HTMLElement;
    expect(within(field).queryByRole('button', { name: /Clear/ })).toBeNull();
    expect(within(field).queryByText('not set')).toBeNull();

    fireEvent.change(key, { target: { value: 'abc' } });
    fireEvent.change(key, { target: { value: '' } });
    expect(key.placeholder).toBe('Saved; type to replace');
    expect(within(field).queryByText('not set')).toBeNull();
    expect(within(field).queryByRole('button', { name: /Clear/ })).toBeNull();
    // Typed and emptied again: nothing changed.
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://svc2.test' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.plugins.settingsSave).toHaveBeenCalled());
    expect(mocks.plugins.settingsSave.mock.calls[0]?.[0].settings).not.toHaveProperty('apiKey');
  });

  it('Save and test is disabled until a field differs from the saved settings, with the reason', async () => {
    await open();
    expect(saveButton().disabled).toBe(true);
    const reasonId = saveButton().getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId as string)?.textContent).toBe('No changes to save');
    // Testing the saved settings is still useful.
    expect(
      (screen.getByRole('button', { name: 'Test connection for service' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    const url = screen.getByLabelText('Server URL');
    fireEvent.change(url, { target: { value: 'https://other.test' } });
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('No changes to save')).toBeNull();

    fireEvent.change(url, { target: { value: 'https://svc.test' } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('No changes to save')).toBeTruthy();
  });

  it('a stored secret left alone keeps Save disabled, even after Replace; typing into it enables Save', async () => {
    await open();
    expect(saveButton().disabled).toBe(true);
    const key = replaceKey();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(key, { target: { value: 'new-key' } });
    expect(saveButton().disabled).toBe(false);
  });

  it("Save and test saves, then tests what was saved; the stored secret stays the server's", async () => {
    const onTested = vi.fn();
    mocks.plugins.settingsSave.mockResolvedValue({
      ...stored,
      settings: { ...stored.settings, url: 'https://other.test' },
    });
    mocks.plugins.settingsTest.mockResolvedValue({
      ok: false,
      kind: 'unreachable',
      message: 'connection refused at other.test',
    });
    renderAt(
      '/plugins',
      <IntegrationSettings
        name="service"
        title="Service"
        effect="Files are still replaced; only the library refresh is skipped."
        onTested={onTested}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Server URL'), {
      target: { value: 'https://other.test' },
    });
    fireEvent.click(saveButton());
    const message = await screen.findByText('connection refused at other.test');
    const result = message.closest('[role="status"]') as HTMLElement;
    expect(mocks.plugins.settingsTest).toHaveBeenCalledWith({
      name: 'service',
      settings: { url: 'https://other.test', pathMappings: [], insecureTls: false },
    });
    expect(result.textContent).toContain('connection refused at other.test');
    expect(result.textContent).toContain(
      'Files are still replaced; only the library refresh is skipped.',
    );
    expect(onTested).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Test connection for Service' })).toBeTruthy();
  });

  it('the stored last test reads as a sentence with when it ran and, when it failed, its effect', async () => {
    mocks.plugins.settingsGet.mockResolvedValue({
      ...stored,
      lastTest: {
        at: new Date(Date.now() - 2 * 60_000).toISOString(),
        result: { ok: false, kind: 'unreachable', message: 'connection refused at jellyfin:8096' },
      },
    });
    renderAt(
      '/plugins',
      <IntegrationSettings name="service" effect="Only the refresh is skipped." />,
    );
    expect(
      await screen.findByText('Test failed 2 min ago: connection refused at jellyfin:8096'),
    ).toBeTruthy();
    expect(screen.getByText('Only the refresh is skipped.')).toBeTruthy();
  });

  it("the plugin's own buttons close the row, and stay when the settings cannot load", async () => {
    const actions = (
      <button type="button" className="btn">
        Remove plugin
      </button>
    );
    renderAt('/plugins', <IntegrationSettings name="service" actions={actions} />);
    await screen.findByLabelText('Server URL');
    const row = screen.getByRole('button', { name: 'Save and test' }).parentElement as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Remove plugin' })).toBeTruthy();
    cleanup();
    mocks.plugins.get.mockRejectedValue(new Error('down'));
    renderAt('/plugins', <IntegrationSettings name="service" actions={actions} />);
    expect(await screen.findByText(/Could not load the settings/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove plugin' })).toBeTruthy();
  });

  it('after a successful save, Save is disabled again', async () => {
    mocks.plugins.settingsSave.mockResolvedValue({
      ...stored,
      settings: { ...stored.settings, url: 'https://other.test' },
    });
    await open();
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://other.test' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.plugins.settingsSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(screen.getByText('No changes to save')).toBeTruthy();
  });

  it('a test result whose message already names the version shows it once', async () => {
    mocks.plugins.settingsTest.mockResolvedValue({
      ok: true,
      message: 'Radarr 6.4.4.10685 at http://x',
      version: '6.4.4.10685',
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection for service' }));
    const status = (await screen.findByText('Radarr 6.4.4.10685 at http://x')).closest(
      '[role="status"]',
    );
    expect(status?.textContent?.split('6.4.4.10685').length).toBe(2);
  });
});

describe('settingsDirty', () => {
  const saved = { url: 'https://a.test', apiKey: { set: true }, opts: { b: 1, a: [1, 2] } };

  it('is false for the saved settings, in any key order, with an untouched secret', () => {
    expect(
      settingsDirty(
        { opts: { a: [1, 2], b: 1 }, apiKey: { set: true }, url: 'https://a.test' },
        saved,
      ),
    ).toBe(false);
  });

  it('is true when a value, a nested value or a typed-over secret differs', () => {
    expect(settingsDirty({ ...saved, url: 'https://b.test' }, saved)).toBe(true);
    expect(settingsDirty({ ...saved, opts: { b: 1, a: [2, 1] } }, saved)).toBe(true);
    expect(settingsDirty({ ...saved, apiKey: 'typed' }, saved)).toBe(true);
    expect(settingsDirty({ ...saved, url: undefined }, saved)).toBe(true);
    expect(settingsDirty({ ...saved, extra: false }, saved)).toBe(true);
  });
});

describe('testResultText', () => {
  it('drops the version when the message already contains it', () => {
    expect(
      testResultText({
        ok: true,
        message: 'Radarr 6.4.4.10685 at http://x',
        version: '6.4.4.10685',
      }),
    ).toEqual({ message: 'Radarr 6.4.4.10685 at http://x', version: null });
  });

  it('keeps the version when the message does not name it', () => {
    expect(testResultText({ ok: true, message: 'Connected', version: '4.0.20' })).toEqual({
      message: 'Connected',
      version: '4.0.20',
    });
    expect(testResultText({ ok: true, message: 'Connected' })).toEqual({
      message: 'Connected',
      version: null,
    });
    expect(testResultText({ ok: false, kind: 'other', message: 'Nope' })).toEqual({
      message: 'Nope',
      version: null,
    });
  });
});
