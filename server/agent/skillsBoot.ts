import { agentLimits } from './config.js';
import { mcpTools } from './mcp.js';
import { registerSkillTools, skillStore } from './skills.js';

/** Re-registers the tools of enabled skills after a restart. Disabled installs stay inert. */
export async function loadEnabledSkills(): Promise<number> {
  const limits = agentLimits();
  if (!limits.skillsEnabled && !limits.mcpEnabled) return 0;
  const enabled = await skillStore.listAllOwners({ where: { status: 'enabled' } });
  let loaded = 0;
  for (const skill of enabled) {
    if (skill.manifest.mcp ? !limits.mcpEnabled : !limits.skillsEnabled) continue;
    registerSkillTools(skill, skill.manifest.mcp ? mcpTools(skill) : []);
    loaded += 1;
  }
  return loaded;
}
