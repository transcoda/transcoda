import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Route, Switch } from 'wouter';
import { renderAt } from './render.tsx';

afterEach(cleanup);

describe('renderAt', () => {
  it('starts at the given path and follows navigate()', () => {
    const view = renderAt(
      '/workflows',
      <Switch>
        <Route path="/workflows">List</Route>
        <Route path="/workflows/:id">{(p) => `Editor ${p.id}`}</Route>
      </Switch>,
    );
    expect(screen.getByText('List')).toBeTruthy();
    view.navigate('/workflows/w1');
    expect(screen.getByText('Editor w1')).toBeTruthy();
    expect(view.location()).toBe('/workflows/w1');
  });
});
