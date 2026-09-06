<script setup lang="ts">
// 状态徽章 = 状态瓦片 + 状态名。瓦片自己讲颜色与动效，这里只管把两者摆在一行里。
import { statusTone } from '@/api/schema'
import StatusTile from './StatusTile.vue'

const props = defineProps<{ status: string; small?: boolean }>()
</script>

<template>
  <span class="badge tiled" :class="[statusTone(status), { compact: props.small }]">
    <!-- 名字就写在右边，瓦片只当图示，读屏不用把状态念两遍。 -->
    <StatusTile :status="status" :size="props.small ? 14 : 16" decorative />
    <span>{{ status }}</span>
  </span>
</template>

<style scoped>
.tiled {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* 瓦片自带一圈边框，左边留满 var(--s2) 会显得徽章被顶开，收一点更贴。 */
  padding-left: 3px;
}
.tiled.compact { gap: var(--s1); padding-left: var(--s1); }
</style>
