import { readFile } from "node:fs/promises"
import { TrueForge } from "@truefoundry/trueforge-sdk"

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790"
const connectorName = process.env.TRUEFORGE_CONNECTOR_NAME ?? "trueforge-extension"
const connectorUrl = process.env.TRUEFORGE_CONNECTOR_URL
const token = process.env.TRUEFORGE_MCP_TOKEN
const agentName = process.env.TRUEFORGE_AGENT_NAME ?? "trueforge-extension-agent"
const modelName = process.env.TRUEFORGE_MODEL

if (!connectorUrl || !token || !modelName) {
  throw new Error(
    "Set TRUEFORGE_CONNECTOR_URL, TRUEFORGE_MCP_TOKEN and TRUEFORGE_MODEL before running bootstrap-trueforge.",
  )
}

const client = new TrueForge({ baseUrl })
const modelsResponse = await client.models.list()
if (!modelsResponse.data.some((model) => model.name === modelName)) {
  throw new Error(`TrueForge model is not configured: ${modelName}`)
}

const connectorResponse = await client.settings.mcpServers.createOrUpdate({
  manifest: {
    name: connectorName,
    description: "VS Code workspace tools for the TrueForge Context Agent.",
    type: "remote",
    url: connectorUrl,
    auth: { type: "header", headers: { Authorization: `Bearer ${token}` } },
  },
})
if (connectorResponse.data.name !== connectorName) {
  throw new Error(`TrueForge returned an unexpected connector: ${connectorResponse.data.name}`)
}

const specification = JSON.parse(await readFile(new URL("../agent/trueforge-extension-agent.json", import.meta.url), "utf8"))

// Map snake_case or camelCase specification to SDK manifest types
const rawServers = specification.mcp_servers ?? specification.mcpServers ?? []
const mcpServers = rawServers.map((server) => ({
  name: connectorName,
  enableTools: server.enable_tools ?? server.enableTools ?? [],
  requireApprovalForTools: server.require_approval_for_tools ?? server.requireApprovalForTools ?? [],
  preloadTools: server.preload_tools ?? server.preloadTools ?? [],
  preload: server.preload ?? false,
}))

const manifest = {
  instructions: specification.instructions,
  model: { name: modelName },
  mcpServers,
  config: {
    iterationLimit: specification.config?.iteration_limit ?? specification.config?.iterationLimit ?? 64,
  },
}

const agentsPage = await client.agents.list()
const agents = []
for await (const agent of agentsPage) agents.push(agent)
const existing = agents.find((agent) => agent.name === agentName)
const response = existing
  ? await client.agents.update(existing.id, { manifest })
  : await client.agents.create({
      name: agentName,
      description: "Version-controlled VS Code coding agent backed by TrueForge.",
      manifest,
    })

if (response.data.name !== agentName) {
  throw new Error(`TrueForge returned an unexpected agent: ${response.data.name}`)
}

// Post-creation assertion: retrieve saved agent to verify attached connector, tools, approvals and config
const savedAgentResponse = await client.agents.get(response.data.id)
const savedAgent = savedAgentResponse.data
const savedManifest = savedAgent.manifest

const attachedConnector = (savedManifest.mcpServers ?? []).find((s) => s.name === connectorName)
if (!attachedConnector) {
  throw new Error(`Assertion failed: connector '${connectorName}' is not attached to agent '${agentName}'`)
}

const expectedTools = [
  "list_workspace",
  "read_file",
  "search_workspace",
  "get_symbols",
  "retrieve_context",
  "propose_changes",
  "apply_hunk",
  "run_command",
]
const enabledTools = attachedConnector.enableTools ?? []
for (const tool of expectedTools) {
  if (!enabledTools.includes(tool)) {
    throw new Error(`Assertion failed: tool '${tool}' is not enabled in saved agent manifest`)
  }
}

const approvalTools = attachedConnector.requireApprovalForTools ?? []
for (const tool of ["apply_hunk", "run_command"]) {
  if (!approvalTools.includes(tool)) {
    throw new Error(`Assertion failed: tool '${tool}' is not configured to require approval in saved agent manifest`)
  }
}

if (savedManifest.model?.name !== modelName) {
  throw new Error(`Assertion failed: model mismatch. Expected '${modelName}', got '${savedManifest.model?.name}'`)
}

if (savedManifest.config?.iterationLimit !== 64) {
  throw new Error(`Assertion failed: iterationLimit mismatch. Expected 64, got ${savedManifest.config?.iterationLimit}`)
}

console.log(JSON.stringify({
  baseUrl,
  connector: { name: connectorName, url: connectorUrl, verified: true },
  agent: {
    id: savedAgent.id,
    name: savedAgent.name,
    model: savedManifest.model.name,
    toolsEnabled: enabledTools.length,
    approvalTools,
    verified: true,
  },
}, null, 2))
