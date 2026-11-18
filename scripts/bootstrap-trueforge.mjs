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
const manifest = {
  ...specification,
  model: { name: modelName },
  mcpServers: specification.mcpServers.map((server) =>
    server.name === connectorName ? server : { ...server, name: connectorName },
  ),
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

console.log(JSON.stringify({
  baseUrl,
  connector: { name: connectorName, url: connectorUrl, tools: "deferred until requested" },
  agent: { name: response.data.name, model: response.data.manifest.model.name },
}, null, 2))
