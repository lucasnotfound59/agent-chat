import { render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { App } from './App';
import { TOKEN_KEY } from './token';

afterEach(() => window.localStorage.removeItem(TOKEN_KEY));

it('asks for the address printed by npm run hub when there is no token', () => {
  render(<App />);
  expect(screen.getByText(/npm run hub/)).toBeTruthy();
});
