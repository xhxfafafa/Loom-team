"use client";

/**
 * AgentInstallPanel - ACP Agent Installation UI
 *
 * Displays a list of agents from the ACP Registry with:
 * - Search/filter functionality
 * - Install/Update/Uninstall buttons
 * - Version and distribution type info
 * - Runtime availability indicators (npx, uvx)
 *
 * Uses server-side API routes for registry lookup and installation.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import { desktopAwareFetch } from "@/client/utils/diagnostics";
import { resolveApiPath } from "@/client/config/backend";
import { useTranslation } from "@/i18n";
import { Search, Bot } from "lucide-react";


// ─── Types ─────────────────────────────────────────────────────────────────

interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  authors: string[];
  license: string;
  icon?: string;
}

interface AgentWithStatus {
  agent: RegistryAgent;
  available: boolean;
  installed: boolean;
  uninstallable: boolean;
  distributionTypes: ("npx" | "uvx" | "binary")[];
}

interface RegistryResponse {
  agents: AgentWithStatus[];
  platform: string | null;
  runtimeAvailability: {
    npx: boolean;
    uvx: boolean;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : fallback;
}

// ─── Component ─────────────────────────────────────────────────────────────

interface AgentInstallPanelProps {
  embedded?: boolean;
}

export function AgentInstallPanel({ embedded = false }: AgentInstallPanelProps) {
  const [agents, setAgents] = useState<AgentWithStatus[]>([]);
  const [platform, setPlatform] = useState<string | null>(null);
  const [runtimeAvailability, setRuntimeAvailability] = useState({ npx: false, uvx: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [installingAgents, setInstallingAgents] = useState<Set<string>>(new Set());
  const { t } = useTranslation();

  // Fetch registry data
  const fetchAgents = useCallback(
    async (refresh = false) => {
      try {
        setLoading(true);
        setError(null);

        const url = resolveApiPath(refresh ? "/api/acp/registry?refresh=true" : "/api/acp/registry");
        const res = await desktopAwareFetch(url);
        if (!res.ok) throw new Error(`Failed to fetch registry: ${res.status}`);
        const data: RegistryResponse = await res.json();
        setAgents(data.agents);
        setPlatform(data.platform);
        setRuntimeAvailability(data.runtimeAvailability);
      } catch (err) {
        setError(getErrorMessage(err, t.agents.failedToLoad));
      } finally {
        setLoading(false);
      }
    },
    [t.agents.failedToLoad]
  );

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Filter agents by search query
  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents;
    const q = searchQuery.toLowerCase();
    return agents.filter(
      (a) =>
        a.agent.name.toLowerCase().includes(q) ||
        a.agent.id.toLowerCase().includes(q) ||
        a.agent.description.toLowerCase().includes(q)
    );
  }, [agents, searchQuery]);

  // Install agent
  const handleInstall = useCallback(
    async (agentId: string, _distType?: string) => {
      setInstallingAgents((prev) => new Set(prev).add(agentId));
      try {
        const res = await desktopAwareFetch("/api/acp/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, distributionType: _distType }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || t.agents.installFailed);
        }
        await fetchAgents();
      } catch (err) {
        setError(getErrorMessage(err, t.agents.installFailed));
      } finally {
        setInstallingAgents((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [fetchAgents, t.agents.installFailed]
  );

  // Uninstall agent
  const handleUninstall = useCallback(
    async (agentId: string) => {
      setInstallingAgents((prev) => new Set(prev).add(agentId));
      try {
        const res = await desktopAwareFetch("/api/acp/install", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || t.agents.uninstallFailed);
        }
        await fetchAgents();
      } catch (err) {
        setError(getErrorMessage(err, t.agents.uninstallFailed));
      } finally {
        setInstallingAgents((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    },
    [fetchAgents, t.agents.uninstallFailed]
  );

  return (
    <div className={`flex h-full flex-col ${embedded ? "" : "bg-white dark:bg-slate-950"}`}>
      <div className={embedded ? "mb-3 space-y-3" : "border-b border-slate-100 px-5 py-4 dark:border-slate-800"}>
        <div className={`flex items-center justify-between ${embedded ? "" : "mb-3"}`}>
          <div className="flex items-center gap-2">
            {!embedded && <AgentIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />}
            <h2 className={`${embedded ? "text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400" : "text-base font-semibold text-slate-900 dark:text-slate-100"}`}>
              {t.agents.acpRegistryTitle}
            </h2>
            {agents.length > 0 && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800">
                {agents.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <RuntimeBadges npx={runtimeAvailability.npx} uvx={runtimeAvailability.uvx} />
            <button
              onClick={() => fetchAgents(true)}
              disabled={loading}
              className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 disabled:opacity-50"
            >
              {loading ? `${t.common.loading}...` : t.common.refresh}
            </button>
          </div>
        </div>

        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.agents.searchAgents}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-4 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-100"
          />
        </div>
      </div>

      {error && (
        <div className={`${embedded ? "mb-3" : "mx-5 mt-3"} rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/20 dark:text-red-300`}>
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">{t.common.dismiss}</button>
        </div>
      )}

      <div className={`flex-1 overflow-y-auto ${embedded ? "" : "px-5 py-3"}`}>
        {loading && agents.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            {t.agents.loadingFromRegistry}
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            {searchQuery ? t.agents.noMatchingAgents : t.agents.noAgentsAvailable}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredAgents.map(({ agent, available, installed, uninstallable, distributionTypes }) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                available={available}
                installed={installed}
                uninstallable={uninstallable}
                distributionTypes={distributionTypes}
                installing={installingAgents.has(agent.id)}
                runtimeAvailability={runtimeAvailability}
                onInstall={handleInstall}
                onUninstall={handleUninstall}
              />
            ))}
          </div>
        )}
      </div>

      {!embedded && (
        <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400 dark:border-slate-800">
          {t.agents.platformRegistry
            .replace('{platform}', platform ?? t.agents.unknownPlatform)
            .replace('{registry}', 'cdn.agentclientprotocol.com')}
        </div>
      )}
    </div>
  );
}


// ─── AgentCard Component ───────────────────────────────────────────────────

interface AgentCardProps {
  agent: RegistryAgent;
  available: boolean;
  installed: boolean;
  uninstallable: boolean;
  distributionTypes: ("npx" | "uvx" | "binary")[];
  installing: boolean;
  runtimeAvailability: { npx: boolean; uvx: boolean };
  onInstall: (agentId: string, distType?: string) => void;
  onUninstall: (agentId: string) => void;
}

function AgentCard({
  agent,
  available,
  installed,
  uninstallable,
  distributionTypes,
  installing,
  runtimeAvailability,
  onInstall,
  onUninstall,
}: AgentCardProps) {
  const { t } = useTranslation();

  // Determine best available distribution type
  const availableDistType = useMemo(() => {
    if (distributionTypes.includes("npx") && runtimeAvailability.npx) return "npx";
    if (distributionTypes.includes("uvx") && runtimeAvailability.uvx) return "uvx";
    if (distributionTypes.includes("binary")) return "binary";
    return null;
  }, [distributionTypes, runtimeAvailability]);

  const canInstall = availableDistType !== null;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 transition-colors hover:border-blue-200 dark:border-slate-700 dark:bg-slate-800/30 dark:hover:border-blue-700/40">
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-amber-500 text-sm font-bold text-white">
          {agent.icon ? (
            <Image src={agent.icon} alt="" width={24} height={24} className="w-6 h-6" />
          ) : (
            agent.name.charAt(0).toUpperCase()
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {agent.name}
            </h3>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-500 dark:bg-slate-700">
              v{agent.version}
            </span>
            {installed && (
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
                {t.agents.installed}
              </span>
            )}
            {!installed && available && (
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/20 dark:text-blue-300">
                {t.agents.available}
              </span>
            )}
          </div>
          <p className="mb-2 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
            {agent.description}
          </p>
          <div className="flex items-center gap-2 text-[10px] text-slate-400">
            <span>{agent.authors.join(", ")}</span>
            <span>•</span>
            <span>{agent.license}</span>
            <span>•</span>
            <div className="flex gap-1">
              {distributionTypes.map((dt) => (
                <span
                  key={dt}
                  className={`px-1 py-0.5 rounded ${
                    (dt === "npx" && runtimeAvailability.npx) ||
                    (dt === "uvx" && runtimeAvailability.uvx) ||
                    dt === "binary"
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-950/20 dark:text-blue-300"
                      : "bg-slate-100 text-slate-400 line-through dark:bg-slate-700"
                  }`}
                >
                  {dt}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {uninstallable ? (
            <button
              onClick={() => onUninstall(agent.id)}
              disabled={installing}
              className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/20"
            >
              {installing ? "..." : t.agents.uninstall}
            </button>
          ) : (
            <button
              onClick={() => onInstall(agent.id, availableDistType ?? undefined)}
              disabled={installing || !canInstall}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {installing ? t.agents.installing : canInstall ? t.agents.install : t.common.unavailable}
            </button>
          )}
          {agent.repository && (
            <a
              href={agent.repository}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
              title={t.agents.viewRepository}
            >
              <GithubIcon className="w-4 h-4" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Helper Components ─────────────────────────────────────────────────────

function RuntimeBadges({ npx, uvx }: { npx: boolean; uvx: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className={`rounded px-1.5 py-0.5 ${npx ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300" : "bg-slate-100 text-slate-400 dark:bg-slate-700"}`}>
        npx {npx ? "✓" : "✗"}
      </span>
      <span className={`rounded px-1.5 py-0.5 ${uvx ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300" : "bg-slate-100 text-slate-400 dark:bg-slate-700"}`}>
        uvx {uvx ? "✓" : "✗"}
      </span>
    </div>
  );
}

function AgentIcon({ className }: { className?: string }) {
  return (
    <Bot className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}/>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <Search className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}/>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}
