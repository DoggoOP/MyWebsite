// WebMCP: read-only tools that let a browser agent explore the site.
// Registers only in browsers that expose the API, so other visitors pay nothing.

interface ToolResult { content: { type: 'text'; text: string }[] }
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}
interface ModelContext { registerTool: (tool: Tool, options?: { signal?: AbortSignal }) => unknown }
interface ProjectSummary { slug: string; title: string; tagline: string; description: string; year: number | null; tags: string[]; url: string }

const CONTACT = {
  email: 'ethank07@stanford.edu',
  github: 'https://github.com/DoggoOP',
  linkedin: 'https://www.linkedin.com/in/ethank07/',
  resume: 'https://ethankong.org/assets/resume.pdf',
};

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

async function register() {
  const mc = ((document as unknown as { modelContext?: ModelContext }).modelContext ??
    (navigator as unknown as { modelContext?: ModelContext }).modelContext);
  if (!mc || typeof mc.registerTool !== 'function') return;

  const projects: ProjectSummary[] = await fetch('/projects.json').then(r => r.json());
  const slugs = projects.map(p => p.slug);

  const tools: Tool[] = [
    {
      name: 'list_projects',
      description: "List Ethan Kong's engineering projects with title, year, tagline, description and page URL.",
      inputSchema: { type: 'object', properties: {} },
      execute: async () => text(projects),
    },
    {
      name: 'get_project',
      description: 'Get the full text of one project write-up on ethankong.org.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', enum: slugs, description: 'Project slug from list_projects, for example "rocketry".' },
        },
        required: ['slug'],
      },
      execute: async ({ slug }) => {
        const project = projects.find(p => p.slug === slug);
        if (!project) return text(`Unknown project "${String(slug)}". Known slugs: ${slugs.join(', ')}`);
        const html = await fetch(`/projects/${project.slug}`).then(r => r.text());
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const body = doc.querySelector('.project-content')?.textContent?.replace(/\n{3,}/g, '\n\n').trim() ?? '';
        return text({ ...project, body });
      },
    },
    {
      name: 'get_contact',
      description: "Get Ethan Kong's email, GitHub, LinkedIn and resume links.",
      inputSchema: { type: 'object', properties: {} },
      execute: async () => text(CONTACT),
    },
  ];

  for (const tool of tools) {
    try { await mc.registerTool(tool); } catch (err) { console.warn(`WebMCP: could not register ${tool.name}`, err); }
  }
}

register().catch(err => console.warn('WebMCP registration failed', err));
