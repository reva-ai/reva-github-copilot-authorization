import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_TYPE } from '../src/ingestionClient';

describe('AGENT_TYPE', () => {
  it('is GitHubCopilot', () => {
    assert.equal(AGENT_TYPE, 'GitHubCopilot');
  });
});
