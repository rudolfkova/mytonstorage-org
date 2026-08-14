"use client"

import { ListChecks, PackageOpen, Trash } from "lucide-react";
import React, { useEffect, useCallback, useMemo } from "react"
import Slider from "react-slider"
import { useTranslation } from "react-i18next";
import { PeriodField } from "../input-period-field";
import { getProviders } from "@/lib/thirdparty";
import { Provider, Providers } from "@/types/mytonstorage";
import { filterAndSortProviders } from "@/lib/utils";
import { TextField } from "../input-text-field";
import { useAppStore } from "@/store/useAppStore";
import { getOffers, removeFile } from "@/lib/api";
import { ProviderInfo } from "@/lib/types";
import { Offers, ProviderDecline } from "@/types/files";
import { useTonConnectUI } from '@tonconnect/ui-react';
import { safeDisconnect } from '@/lib/ton/safeDisconnect';
import { useIsMobile } from "@/hooks/useIsMobile";
import { ProvidersListMobile } from "./providers-list-mobile";
import { ProvidersListDesktop } from "./providers-list-desktop";
import { FiltersSection, locationStates, sortingStates } from "../filters";
import { DAY_SECONDS, WEEK_DAYS } from "@/lib/storage-constants";
import { FreeStorageDisplay } from "../free-storage-display";

export default function ChooseProviders() {
  const { t } = useTranslation();
  const { upload, updateWidgetData, resetWidgetData } = useAppStore();
  const widgetData = upload.widgetData;
  const [tonConnectUI] = useTonConnectUI();
  const isMobile = useIsMobile();

  const [isLoading, setIsLoading] = React.useState(false);
  const [offersLoading, setOffersLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [warn, setWarn] = React.useState<string | null>(null);

  const [allProviders, setAllProviders] = React.useState<Provider[]>([]);
  const [manualProviders, setManualProviders] = React.useState<Provider[]>([]);
  const [providers, setProviders] = React.useState<ProviderInfo[]>([]);
  const [visibleProviders, setVisibleProviders] = React.useState<ProviderInfo[]>([]);

  const [selectedProvidersCount, setSelectedProvidersCount] = React.useState(3);
  const [locationFilter, setLocationFilter] = React.useState<keyof typeof locationStates>("differentCountries");
  const [sortingFilter, setSortingFilter] = React.useState<keyof typeof sortingStates>("randomSorting");
  const [proofPeriodDays, setProofPeriodDays] = React.useState<number>(WEEK_DAYS);

  const [newProviderPubkey, setNewProviderPubkey] = React.useState("");
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [advanced, setAdvanced] = React.useState(false);

  const [gotBackendExpired, setGotBackendExpired] = React.useState(false);

  const isExpired = useCallback(() => {
    return (
      (widgetData!.bagInfo?.created_at || 0) + (widgetData!.freeStorage || 0) < Math.floor(Date.now() / 1000)
    ) || gotBackendExpired;
  }, [widgetData, gotBackendExpired]);

  const hasDeclines = useMemo(() => visibleProviders.some(p => p.decline != null), [visibleProviders]);
  const hasEmptyOffers = useMemo(() => visibleProviders.some(p => p.offer === null), [visibleProviders]);
  const canContinue = useMemo(() => {
    return !offersLoading && !isLoading && visibleProviders.length > 0 && !hasDeclines && !hasEmptyOffers;
  }, [offersLoading, isLoading, visibleProviders.length, hasDeclines, hasEmptyOffers]);

  // Upload providers list on component mount
  useEffect(() => {
    const load = async () => {
      if (isExpired()) {
        setError(t('errors.storageTimeExpired'));
        return;
      }

      setIsLoading(true);
      setError(null);

      const resp = await getProviders();
      const prv = resp.data as Providers;
      if (prv) {
        setAllProviders(prv.providers);
      } else if (resp?.error) {
        setError(resp.error);
      }

      setIsLoading(false);
    };

    load();
  }, [widgetData.bagInfo]);

  // Offers are quoted for a specific proof period, reset them on change
  useEffect(() => {
    setProviders(prev => prev.map(p => ({ ...p, offer: null, decline: null })));
  }, [proofPeriodDays]);

  // Applying filters
  useEffect(() => {
    if (allProviders.length === 0) return;

    const filtered = filterAndSortProviders(
      allProviders,
      selectedProvidersCount,
      proofPeriodDays,
      locationFilter,
      sortingFilter
    );

    const proofPeriodSeconds = proofPeriodDays * DAY_SECONDS;
    const manualToAdd = manualProviders.filter(
      mp => mp.min_span <= proofPeriodSeconds && mp.max_span >= proofPeriodSeconds
        && !filtered.some(fp => fp.pubkey === mp.pubkey)
    );

    const allFiltered = [...filtered, ...manualToAdd];

    setProviders(prev => {
      const prevMap = new Map(prev.map(p => [p.provider.pubkey, p]));
      return allFiltered.map(provider => {
        const existing = prevMap.get(provider.pubkey);
        return {
          provider,
          offer: existing?.offer ?? null,
          decline: existing?.decline ?? null
        };
      });
    });
  }, [allProviders, manualProviders, selectedProvidersCount, proofPeriodDays, locationFilter, sortingFilter]);

  // Sync visibleProviders with providers
  useEffect(() => {
    setVisibleProviders(providers);
  }, [providers]);

  // Loading offers for providers without offers
  useEffect(() => {
    if (isLoading || offersLoading) return;
    if (providers.length === 0) return;

    const needOffers = providers.some(p => p.offer === null && p.decline === null);
    if (!needOffers) return;

    const timer = setTimeout(() => loadOffers(), 300);
    return () => clearTimeout(timer);
  }, [providers, isLoading, offersLoading]);

  const loadOffers = async () => {
    if (isLoading || offersLoading) return;
    if (isExpired()) {
      setError(t('errors.storageTimeExpired'));
      return;
    }

    const providersToLoad = providers.filter(p => p.offer === null && p.decline === null);
    if (providersToLoad.length === 0) return;

    setOffersLoading(true);
    setError(null);
    setWarn(null);

    try {
      const resp = await getOffers(
        providersToLoad.map(p => p.provider.pubkey),
        widgetData!.bagInfo!.bag_id,
        0,
        proofPeriodDays * DAY_SECONDS
      );

      if (resp.status === 401) {
        setError(t('errors.unauthorizedLoggingOut'));
        safeDisconnect(tonConnectUI);
        return;
      }

      if (resp.status === 410) {
        console.info("backend reports expired bag");
        setGotBackendExpired(true);
        setError(t('chooseProviders.expiredBag'));
        return;
      }

      const data = resp.data as Offers;
      if (data) {
        setProviders(current => current.map(provider => {
          const offer = data.offers?.find(
            o => o.provider.key.toLowerCase() === provider.provider.pubkey.toLowerCase()
          ) || null;

          const decline = data.declines?.find(
            d => d.provider_key.toLowerCase() === provider.provider.pubkey.toLowerCase()
          ) || null;

          return {
            provider: provider.provider,
            offer: offer ?? provider.offer,
            decline: decline?.reason ?? provider.decline
          };
        }));

        if (data.declines?.length) {
          setWarn(t('chooseProviders.someProvidersDeclinedWarn'));
        }
      } else if (resp?.error) {
        setError(resp.error);
      }
    } finally {
      setOffersLoading(false);
    }
  };

  const addProvider = async (pubkey: string) => {
    if (isLoading || offersLoading) return;
    if (isExpired()) {
      setError(t('errors.storageTimeExpired'));
      return;
    }

    if (visibleProviders.find(p => p.provider.pubkey === pubkey)) {
      setWarn(t('chooseProviders.providerAlreadyAdded'));
      return;
    }

    setIsLoading(true);
    setError(null);
    setWarn(null);

    try {
      const resp = await getProviders([pubkey]);
      const prs = resp.data as Providers;

      if (prs?.providers.length) {
        const provider = prs.providers[0];
        const proofPeriodSeconds = proofPeriodDays * DAY_SECONDS;
        if (provider.min_span > proofPeriodSeconds || provider.max_span < proofPeriodSeconds) {
          setWarn(t('chooseProviders.providerSpanNotSupported'));
          return;
        }
        setManualProviders(prev => {
          const stillVisible = prev.filter(mp =>
            visibleProviders.some(vp => vp.provider.pubkey === mp.pubkey)
          );
          return [...stillVisible, provider];
        });
      } else if (prs?.providers.length === 0) {
        setWarn(t('chooseProviders.noProvidersFound'));
      } else if (resp?.error) {
        setError(resp.error);
      }
    } finally {
      setIsLoading(false);
      setNewProviderPubkey("");
    }
  };

  const removeProvider = (pubkey: string) => {
    setVisibleProviders(prev => prev.filter(p => p.provider.pubkey !== pubkey));
    setWarn(null);
  };

  const nextStep = () => {
    console.info("Selected providers:", visibleProviders);

    updateWidgetData({
      proofPeriodDays,
      providers: visibleProviders,
      selectedProviders: visibleProviders.map(p => p.provider.pubkey)
    });
  };

  const cancelStorage = async () => {
    setIsLoading(true);

    const resp = await removeFile(widgetData.newBagID as string);
    if (resp.status === 401) {
      safeDisconnect(tonConnectUI);
      setIsLoading(false);
      return;
    }

    if (resp.data === true) {
      resetWidgetData();
    } else if (resp.error) {
      console.error("Failed to cancel storage:", resp.error);
    }

    setIsLoading(false);
  };

  const providersCount = () => {
    return (
      <div className={`flex ${isMobile ? 'flex-col' : 'items-center'} my-4 mx-auto gap-4`}>
        <label className={`${isMobile ? 'text-left' : ''} text-gray-700`}>
          {t('chooseProviders.chooseProvidersCount')}: {selectedProvidersCount}
        </label>
        <Slider
          className={`h-4 ${isMobile ? '' : 'flex-1 translate-y-1'}`}
          min={1}
          max={10}
          value={selectedProvidersCount}
          onChange={(value) => setSelectedProvidersCount(value)}
          renderThumb={(props: any) => {
            const { key, ...restProps } = props;
            return <div key={key} {...restProps} className="bg-blue-500 rounded-full w-4 h-4 translate-y-[-25%] cursor-pointer" />
          }}
          renderTrack={(props: any, state: any) => {
            const { key, ...restProps } = props;
            return <div key={key} {...restProps} className={`h-2 rounded-full ${state.index === 0 ? 'bg-blue-500' : 'bg-gray-300'}`} />
          }}
        />
      </div>
    )
  }

  return (
    <div className={`${isMobile ? 'mt-4' : 'mt-16'}`}>
      {/* Provider list */}
      <div className="flex">
        <div className="flex items-center justify-between gap-2 my-4">
          <div className="flex items-center">
            <ListChecks className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg pl-2 font-semibold text-gray-900">{t('chooseProviders.selectProviders')}</h2>
          </div>
        </div>
      </div>

      {/* Error message */}
      {!isLoading && error && (
        <div className="flex flex-col items-center p-4 my-4 bg-red-50 rounded-lg ">
          <p className="text-red-600">{error}</p>
        </div>
      )}

      <div className="rounded-lg border bg-gray-50 border-gray-50 mp-4 p-4">
        {/* Providers count */}
        {/* Free storage countdown */}
        {providersCount()}
        {
          widgetData.bagInfo && (
            <FreeStorageDisplay
              expirationTime={(widgetData.bagInfo.created_at || 0) + (widgetData.freeStorage || 0)}
              isMobile={isMobile}
            />
          )
        }

        {/* Filters */}
        <div className="mt-4">
          <FiltersSection
            locationFilter={locationFilter}
            sortingFilter={sortingFilter}
            onLocationFilterChange={setLocationFilter}
            onSortingFilterChange={setSortingFilter}
            isMobile={isMobile}
          />
        </div>
      </div>

      {/* Advanced options selector */}
      <div className="flex  my-2 justify-end">
        <button
          onClick={() => {
            setProofPeriodDays(WEEK_DAYS);
            setAdvanced(!advanced);
          }}
          disabled={isLoading || offersLoading}
          className="text-sm text-gray-600 hover:text-gray-800 disabled:cursor-not-allowed"
        >
          {advanced ? t('chooseProviders.hideAdvanced') : t('chooseProviders.showAdvanced')}
        </button>
      </div>

      {/* Advanced options */}
      {advanced && (
        <div className="rounded-lg border bg-gray-50 border-gray-50 mp-4 p-4">
          {/* Proof period selector */}
          <div>
            <PeriodField
              label={t('chooseProviders.storageProofEach')}
              suffix={t('time.day')}
              value={proofPeriodDays}
              onChange={setProofPeriodDays}
              disabled={isLoading || offersLoading}
              isMobile={isMobile ?? false}
            />
          </div>

          <div className={`flex gap-4 mt-2 ${isMobile ? 'flex-col items-center w-full' : 'items-center justify-center'}`}>
            <TextField
              onChange={setNewProviderPubkey}
              label={t('chooseProviders.addCustomProvider')}
              placeholder={t('chooseProviders.placeholderPubkey')}
              horizontal={!isMobile}
            />

            <button
              className={`btn text-md flex items-center border rounded px-4 py-2 hover:bg-gray-100 justify-center ${isMobile ? 'w-full max-w-sm' : 'whitespace-nowrap'
                }`}
              onClick={() => addProvider(newProviderPubkey)}
              disabled={isLoading || offersLoading || newProviderPubkey.length !== 64}
            >
              <PackageOpen className="h-4 w-4 mr-2" />
              {t('chooseProviders.loadInfo')}
            </button>
          </div>
        </div>
      )}

      {/* Providers list */}
      <div className="mt-8">
        {!isLoading && visibleProviders.length > 0 && (
          <>
            {/* Providers list */}
            {isMobile ? (
              <ProvidersListMobile
                providers={visibleProviders}
                copiedKey={copiedKey}
                setCopiedKey={setCopiedKey}
                removeProvider={removeProvider}
              />
            ) : (
              <ProvidersListDesktop
                providers={visibleProviders}
                copiedKey={copiedKey}
                advanced={advanced}
                setCopiedKey={setCopiedKey}
                removeProvider={removeProvider}
              />
            )}

            {/* Just info counter */}
            <div className={`${isMobile ? 'px-1' : 'm-4'}`}>
              <p className={`text-sm text-gray-600 ${isMobile ? 'text-center mt-4' : 'text-right'}`}>
                {t('chooseProviders.providersCountInfo', { count: visibleProviders.length })}
              </p>
            </div>
          </>
        )}
      </div>

      {!error && warn && (
        <div className="flex flex-col items-center p-4 bg-yellow-50 rounded-lg">
          <p>{warn}</p>
        </div>
      )}

      {/* Cancel, Go next step */}
      <div className={`flex mt-8 ${isMobile ? 'justify-center w-full' : 'justify-end'}`}>
        <button
          className="btn px-4 py-2 text-md text-gray-700 flex items-center border rounded mx-4 hover:bg-gray-100"
          onClick={cancelStorage}
        >
          {t('newBag.cancelStorage')}
        </button>

        <button
          className="btn px-4 py-2 rounded bg-blue-500 text-white mx-4 disabled:cursor-not-allowed"
          onClick={nextStep}
          disabled={!canContinue}
        >
          {t('chooseProviders.continue')}
        </button>
      </div>
    </div>
  )
}
