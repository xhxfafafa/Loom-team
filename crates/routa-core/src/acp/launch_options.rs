//! Per-session ACP launch configuration.

#[derive(Debug, Clone, Default)]
pub struct SessionLaunchOptions {
    pub specialist_id: Option<String>,
    pub specialist_system_prompt: Option<String>,
    /// Team execution chain for top-level team-agent-lead sessions; `None`
    /// represents legacy Full Delivery.
    pub team_chain_id: Option<String>,
    pub allowed_native_tools: Option<Vec<String>>,
    pub initialize_timeout_ms: Option<u64>,
    pub provider_args: Option<Vec<String>>,
    pub acp_mcp_servers: Option<Vec<serde_json::Value>>,
}
