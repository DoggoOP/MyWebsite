import { SITE } from './siteIndex';

/** Agentic Resource Discovery manifest, served at /.well-known/ard.json and the older ai-catalog.json path. */
export function agentManifest() {
  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: 'urn:air:ethankong.org:site:llms-txt',
        displayName: 'Ethan Kong, site guide for language models',
        type: 'text/markdown',
        url: `${SITE}/llms.txt`,
        description: 'Markdown summary of Ethan Kong, a Stanford Aero/Astro student, with links to every page and project write-up.',
        representativeQueries: [
          'who is Ethan Kong',
          'what engineering projects has Ethan Kong built',
          'how do I contact Ethan Kong',
        ],
        tags: ['portfolio', 'aerospace', 'stanford'],
      },
      {
        identifier: 'urn:air:ethankong.org:webmcp:portfolio',
        displayName: 'Ethan Kong portfolio tools (WebMCP)',
        type: 'text/html',
        url: `${SITE}/`,
        description: 'Read-only WebMCP tools registered on every page of ethankong.org for listing projects, reading a project write-up, and getting contact links.',
        capabilities: ['list_projects', 'get_project', 'get_contact'],
        representativeQueries: [
          `list Ethan Kong's projects`,
          `read Ethan Kong's rocketry write-up`,
          'find Ethan Kong on GitHub or LinkedIn',
        ],
      },
    ],
  };
}
