import { useTranslation } from "react-i18next";

export function useUpgradeLabel() {
  const { t } = useTranslation();
  return t("This feature is not available in the community edition.");
}
