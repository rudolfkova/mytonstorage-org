"use client"

import { useState, useEffect, useCallback } from "react"
import { useIsMobile } from "@/hooks/useIsMobile"
import { StoragePeriodSlider } from "../storage-period-slider"
import { FreeStorageDisplay } from "../free-storage-display"
import { DAY_SECONDS, WEEK_DAYS, DEFAULT_INIT_BALANCE, FEE_PROOF, FEE_INIT } from "@/lib/storage-constants"
import { useTonAddress, useTonConnectUI } from "@tonconnect/ui-react"
import { useTranslation } from "react-i18next"
import { useAppStore } from "@/store/useAppStore"
import { InitStorageContract, Transaction } from "@/lib/types"
import { getDeployTransaction } from "@/lib/api"
import { safeDisconnect } from "@/lib/ton/safeDisconnect"
import { sendTransactionWithFallback } from "@/lib/ton/transactions"
import { AlarmClock } from "lucide-react"
import { setBagStorageContract } from "@/lib/api";

export default function ChooseStoragePeriod() {
    const userAddress = useTonAddress(true);
    const [tonConnectUI] = useTonConnectUI();
    const [initialBalance, setInitialBalance] = useState<number>(0);
    const [storagePeriodDays, setStoragePeriodDays] = useState<number>(28);
    const [error, setError] = useState<string | React.ReactNode | null>(null)
    const [tx, setTx] = useState<Transaction | null>(null);
    const isMobile = useIsMobile();
    const { upload, updateWidgetData } = useAppStore();
    const widgetData = upload.widgetData;
    const providers = widgetData.providers || [];
    const proofPeriodDays = widgetData.proofPeriodDays || WEEK_DAYS;
    const { t } = useTranslation();

    const isExpired = useCallback(() => {
        return (widgetData!.bagInfo?.created_at || 0) + (widgetData!.freeStorage || 0) < Math.floor(Date.now() / 1000);
    }, [widgetData]);

    const getExpirationDate = () => {
        const expirationTimestamp = (Date.now() / 1000) + (storagePeriodDays * DAY_SECONDS);
        return new Date(expirationTimestamp * 1000).toLocaleDateString();
    };

    const calculateBalance = (selectedDays: number) => {
        const allProvidersPricePerProof = providers.reduce((prev, curr) => {
            let v = curr.offer?.price_per_proof || 0;
            if (v !== 0) {
                v += FEE_PROOF;
            }
            return prev + v;
        }, 0);

        const payments = Math.ceil(selectedDays / proofPeriodDays);
        const totalPrice = Math.max(allProvidersPricePerProof * payments + FEE_INIT, DEFAULT_INIT_BALANCE);

        setInitialBalance(totalPrice);
    };

    useEffect(() => {
        if (!tx) {
            return;
        }

        sendTransaction();
    }, [tx]);

    useEffect(() => {
        calculateBalance(storagePeriodDays);
    }, [storagePeriodDays]);

    const handlePeriodChange = (days: number) => {
        setStoragePeriodDays(days);
        calculateBalance(days);
    };

    const getDeployTx = async () => {
        setError(null);

        if (widgetData!.bagInfo!.created_at + widgetData!.freeStorage! < Math.floor(Date.now() / 1000)) {
            console.log("Bag storage time expired");
            setError(t('errors.storageTimeExpired'));
            return;
        }

        if (!initialBalance || !userAddress || !widgetData.newBagID || providers.length === 0) {
            console.error("Missing required data for deployment", initialBalance, userAddress, widgetData.newBagID, providers);
            return;
        }

        try {
            const req = {
                bag_id: widgetData.newBagID,
                providers: providers.map((p) => {
                    return p.provider.pubkey;
                }),
                amount: initialBalance,
                owner_address: userAddress,
                span: proofPeriodDays * DAY_SECONDS,
            } as InitStorageContract;
            const resp = await getDeployTransaction(req);
            if (resp.status === 401) {
                setError(t('errors.unauthorizedLoggingOut'));
                console.error('getDeployTransaction unauthorized. Logging out.');
                safeDisconnect(tonConnectUI);
                return;
            }
            var tx = resp.data as Transaction;
            if (tx) {
                console.log("Got deploy transaction:", tx);
                setTx(tx)
            } else if (resp && resp.error) {
                console.error("Failed to get deploy transaction:", resp.error);
                setError(resp.error);
            }
        } catch (error) {
            console.error("Failed to get deploy transaction:", error);
            setError(t('chooseProviders.failedToGetDeployTransaction'));
        }
    }

    const goBack = async () => {
        updateWidgetData({
            proofPeriodDays,
            providers: [],
            selectedProviders: [],
            storageContractAddress: undefined,
            paymentStatus: undefined,
        });
    };

    const sendTransaction = async () => {
        if (widgetData!.bagInfo!.created_at + widgetData!.freeStorage! < Math.floor(Date.now() / 1000)) {
            console.log("Bag storage time expired");
            setError(t('errors.storageTimeExpired'));
            return;
        }

        if (!widgetData.newBagID) {
            console.error("No new bag ID available");
            setError(t('errors.unknownErrorOccurred'));
            return;
        }

        if (!userAddress) {
            console.error("No user address available");
            setError(t('errors.unknownErrorOccurred'));
            return;
        }

        const message = {
            address: tx!.address,
            amount: tx!.amount.toString(),
            stateInit: tx!.state_init,
            payload: tx!.body,
        };

        console.log("Sending transaction:", message);

        const result = await sendTransactionWithFallback({
            tonConnectUI,
            message,
            contractAddress: tx!.address,
            userAddress,
            timeoutMs: 1000 * 60 * 4,
            pollingIntervalMs: 5000,
        });

        console.log("Transaction result:", result);

        if (result.success) {
            updateWidgetData({
                storageContractAddress: tx!.address,
            });
            sendStorageContract(widgetData.newBagID, tx!.address);
        } else {
            console.error("Transaction failed:", result.error);
            setError(t('errors.failedToSendTransaction'));
        }
    };

    const sendStorageContract = async (bagid: string, storageContractAddress: string) => {
        setError(null);

        const response = await setBagStorageContract(bagid, storageContractAddress);
        if (response.status === 401) {
            setError(t('errors.unauthorizedLoggingOut'));
            console.error('setBagStorageContract unauthorized. Logging out.');
            safeDisconnect(tonConnectUI);
            return;
        }
        
        if (response.error) {
            setError(t('errors.tryResendAddressError', { error: response.error }));
            console.error("Failed to set bag storage contract:", response.error);
        } else if (response.data) {
            console.log("Successfully set bag storage contract");
            updateWidgetData({
                paymentStatus: "success",
            });
        } else {
            setError(t('errors.unknownErrorTryResend'));
        }
    };

    return (
        <div className={`${isMobile ? 'mt-4' : 'mt-16'}`}>
            <div className="flex items-center justify-between gap-2 my-4">
                <div className="flex items-center">
                    <AlarmClock className="w-5 h-5 text-blue-600" />
                    <h2 className="text-lg pl-2 font-semibold text-gray-900">{t('chooseProviders.selectTimePeriod')}</h2>
                </div>
            </div>

            {/* Error message */}
            {error && (
                <div className="flex flex-col items-center p-4 my-4 bg-red-50 rounded-lg ">
                    <p className="text-red-600">{error}</p>
                </div>
            )}

            <div className="rounded-lg border bg-gray-50 border-gray-50 my-4 p-4">
                <div className="my-4">
                    <StoragePeriodSlider
                        value={storagePeriodDays}
                        onChange={handlePeriodChange}
                        disabled={false}
                    />
                </div>

                {/* Free storage */}
                {
                    widgetData.bagInfo && (
                        <FreeStorageDisplay
                            expirationTime={(widgetData.bagInfo!.created_at || 0) + (widgetData.freeStorage || 0)}
                            isMobile={isMobile}
                        />
                    )
                }

                {/* Balance info */}
                <div className={`flex ${isMobile ? 'flex-col' : 'place-content-between'} gap-4 mt-4`}>
                    <label className="text-gray-700">
                        {t('storage.coinsNeed')}:
                    </label>
                    <span className="text-sm font-medium text-gray-700">
                        {(initialBalance / 1_000_000_000).toFixed(3)} TON
                    </span>
                </div>

                {/* Expiration */}
                <div className={`flex ${isMobile ? 'flex-col' : 'place-content-between'} gap-4 mt-4`}>
                    <label className="text-gray-700">
                        {t('storage.exDate')}:
                    </label>
                    <span className="text-sm font-medium text-gray-700">
                        {getExpirationDate()}
                    </span>
                </div>
            </div>

            {/* Cancel, Send tx */}
            <div className={`flex mt-8 ${isMobile ? 'justify-center w-full' : 'justify-end'}`}>
                <button
                    className="btn px-4 py-2 text-md text-gray-700 flex items-center border rounded mx-4 hover:bg-gray-100"
                    onClick={goBack}
                >
                    {t('newBag.goBack')}
                </button>

                <button
                    className="btn px-4 py-2 rounded bg-blue-500 text-white mx-4 disabled:cursor-not-allowed disabled:bg-gray-400"
                    onClick={getDeployTx}
                    disabled={initialBalance <= 0 || isExpired()}
                >
                    {t('storage.sendTransaction', 'Отправить транзакцию')}
                </button>
            </div>
        </div>
    )
}
