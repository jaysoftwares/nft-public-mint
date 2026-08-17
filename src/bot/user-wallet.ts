import { ZeroAddress } from "ethers";
import { ManagedWallet, UnlockedStore } from "../core/wallet-store";

export interface UserFundingWallet {
  wallet: ManagedWallet;
  /** True when the caller must persist this address in the user's config. */
  needsConfigUpdate: boolean;
}

/** Reserve one wallet in a user's store for funding and reclaiming ETH. */
export function ensureUserFundingWallet(
  store: UnlockedStore,
  configuredFunder: string
): UserFundingWallet {
  const needsConfigUpdate = configuredFunder === ZeroAddress;
  let wallet = needsConfigUpdate
    ? store.byId("d:0")
    : store.all().find(
        (candidate) => candidate.address.toLowerCase() === configuredFunder.toLowerCase()
      );

  if (!wallet && needsConfigUpdate) wallet = store.generate(1)[0];
  if (!wallet) {
    throw new Error(`Configured funder ${configuredFunder} is not in this user's wallet store.`);
  }

  // The funder holds campaign ETH; autonomous minting must never spend from it.
  if (wallet.autoFire) store.setAutoFire(wallet.id, false);
  if (!wallet.tags.includes("funder")) store.addTag(wallet.id, "funder");

  const refreshed = store.byId(wallet.id);
  if (!refreshed) throw new Error(`Funding wallet ${wallet.id} disappeared from the wallet store.`);
  return { wallet: refreshed, needsConfigUpdate };
}
