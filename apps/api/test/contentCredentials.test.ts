import { inspectContentCredentials } from '../src/contentCredentials';

describe('Content Credentials inspection', () => {
  it('does not treat the presence of a credential as proof of AI origin', () => {
    expect(inspectContentCredentials(Buffer.from('C2PA manifest assertion'))).toMatchObject({ present: true, evidence: 'c2pa:credential-present' });
    expect(inspectContentCredentials(Buffer.from('C2PA manifest assertion')).provenance).toBeUndefined();
  });

  it('stores bounded evidence when a credential declares generative media', () => {
    expect(inspectContentCredentials(Buffer.from('C2PA trainedAlgorithmicMedia assertion'))).toMatchObject({
      present: true,
      provenance: { kind: 'ai-generated', source: 'content-credentials', evidence: 'c2pa:generative-assertion' }
    });
  });
});
