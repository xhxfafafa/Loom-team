"use client";

/**
 * TeamChainSelector - compact execution-chain picker for the Team launcher.
 *
 * Presentational component: the parent owns the effective selection and the
 * recommendation (derived from the current request text). This component only
 * renders the three localized chain options, marks the recommended one, and
 * surfaces the analysis-only caveat. All strings go through i18n.
 */

import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Layers } from "lucide-react";
import { useTranslation } from "@/i18n";
import {
  TEAM_CHAIN_IDS,
  type TeamChainId,
  type TeamChainRecommendation,
} from "@/core/orchestration/team-chain";

interface TeamChainSelectorProps {
  /** Advisory recommendation derived from the current request text. */
  recommendation: TeamChainRecommendation;
  /** The effective chain that will be used if the run starts now. */
  selectedChainId: TeamChainId;
  /** Called when the user explicitly picks a chain. */
  onSelect: (chainId: TeamChainId) => void;
}

type ChainLabelKey = "lightweight" | "standardDelivery" | "fullDelivery";

function chainLabelKey(chainId: TeamChainId): ChainLabelKey {
  switch (chainId) {
    case "lightweight":
      return "lightweight";
    case "standard_delivery":
      return "standardDelivery";
    default:
      return "fullDelivery";
  }
}

export function TeamChainSelector({
  recommendation,
  selectedChainId,
  onSelect,
}: TeamChainSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const names: Record<ChainLabelKey, string> = {
    lightweight: t.teamChain.lightweight,
    standardDelivery: t.teamChain.standardDelivery,
    fullDelivery: t.teamChain.fullDelivery,
  };
  const purposes: Record<ChainLabelKey, string> = {
    lightweight: t.teamChain.lightweightPurpose,
    standardDelivery: t.teamChain.standardDeliveryPurpose,
    fullDelivery: t.teamChain.fullDeliveryPurpose,
  };
  const patterns: Record<ChainLabelKey, string> = {
    lightweight: t.teamChain.lightweightPattern,
    standardDelivery: t.teamChain.standardDeliveryPattern,
    fullDelivery: t.teamChain.fullDeliveryPattern,
  };
  const verifications: Record<ChainLabelKey, string> = {
    lightweight: t.teamChain.lightweightVerification,
    standardDelivery: t.teamChain.standardDeliveryVerification,
    fullDelivery: t.teamChain.fullDeliveryVerification,
  };

  const selectedKey = chainLabelKey(selectedChainId);
  const isFollowingRecommendation = selectedChainId === recommendation.chainId;

  const reasonText = (() => {
    switch (recommendation.reason) {
      case "high_risk":
        return t.teamChain.reasonHighRisk;
      case "bounded_scope":
        return t.teamChain.reasonBoundedScope;
      case "analysis_only":
        return t.teamChain.reasonAnalysisOnly;
      default:
        return t.teamChain.reasonStandardTask;
    }
  })();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-testid="team-chain-selector"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={t.teamChain.label}
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-amber-300/60 hover:bg-white dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-amber-700/40"
      >
        <Layers className="h-3.5 w-3.5 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7} />
        <span className="max-w-32 truncate" data-testid="team-chain-selector-value">
          {names[selectedKey]}
        </span>
        {isFollowingRecommendation ? (
          <span className="rounded-full bg-amber-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            {t.teamChain.recommended}
          </span>
        ) : null}
        <ChevronDown className={`h-3 w-3 opacity-50 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label={t.teamChain.label}
          className="absolute bottom-full left-0 z-50 mb-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
              {t.teamChain.label}
            </span>
            <span className="text-[10px] text-slate-400 dark:text-slate-500">{reasonText}</span>
          </div>
          <div className="p-1">
            {TEAM_CHAIN_IDS.map((chainId) => {
              const key = chainLabelKey(chainId);
              const isSelected = chainId === selectedChainId;
              const isRecommended = chainId === recommendation.chainId;
              return (
                <button
                  key={chainId}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`team-chain-option-${chainId}`}
                  onClick={() => {
                    onSelect(chainId);
                    setOpen(false);
                  }}
                  className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                    isSelected
                      ? "bg-amber-50 dark:bg-amber-950/20"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold ${isSelected ? "text-amber-700 dark:text-amber-300" : "text-slate-800 dark:text-slate-100"}`}>
                      {names[key]}
                    </span>
                    {isRecommended ? (
                      <span className="rounded-full bg-amber-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                        {t.teamChain.recommended}
                      </span>
                    ) : null}
                    {isSelected ? (
                      <Check className="ml-auto h-3.5 w-3.5 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} />
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300">{purposes[key]}</div>
                  <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                    <span>{patterns[key]}</span>
                    <span>{verifications[key]}</span>
                  </div>
                </button>
              );
            })}
          </div>
          {recommendation.analysisOnly ? (
            <div className="border-t border-amber-100 bg-amber-50/60 px-3 py-2 text-[10px] leading-4 text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300" data-testid="team-chain-analysis-note">
              {t.teamChain.analysisOnlyNote}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
