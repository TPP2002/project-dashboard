const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../web/src/components/TaskDrawer.vue'), 'utf8');
const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));
const sections = [...template.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)];
const actions = sections.filter(section => /<div class="sec-t">操作<\/div>/.test(section[0]));

test('操作 is the first section after the title and before collection instructions', () => {
  assert.equal(actions.length, 1);
  const title = template.indexOf('class="d-title-row"');
  const brief = sections.find(section => /class="[^"]*\bbrief-sec\b/.test(section[0]));
  assert.ok(title >= 0);
  assert.ok(brief);
  assert.ok(actions[0].index > title);
  assert.ok(actions[0].index < brief.index);
  assert.equal(sections[0], actions[0]);
});

test('there is no separate 协作操作 heading', () => {
  assert.doesNotMatch(template, /class="sec-t"\s*>\s*协作操作\s*</);
});

test('操作 contains inline collaboration buttons before legacy buttons and retains the reason form', () => {
  assert.equal(actions.length, 1);
  const section = actions[0][0];
  assert.match(section, /<OwnerTaskActions\b[^>]*variant="drawer"\s+inline\b/);
  assert.match(section, /<OwnerCollaborators\b[^>]*isCollaborationOwner\(\)/);
  assert.ok(section.indexOf('<OwnerTaskActions') < section.indexOf('v-for="entry in availableActions"'));
  assert.match(section, /<form v-if="activeAction"[\s\S]*@submit.prevent="submitAction"/);
  assert.match(source, /ownerHiddenLegacyActions\(collaborationOwnerUser\(\)\)\.includes\(entry.action\)/);
});

test('activity remains after 操作', () => {
  assert.equal(actions.length, 1);
  const activity = sections.find(section => /<div class="sec-t">活动<\/div>/.test(section[0]));
  assert.ok(activity);
  assert.ok(activity.index > actions[0].index);
});
