import { Skeleton, Stack } from "@mantine/core";

export function BaseTableSkeleton(_props: any) {
  return (
    <Stack gap="xs">
      <Skeleton height={28} />
      <Skeleton height={28} />
      <Skeleton height={28} />
    </Stack>
  );
}
