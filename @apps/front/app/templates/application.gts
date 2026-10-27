import { pageTitle } from 'ember-page-title';
import FlashMessage from 'ember-cli-flash/components/flash-message';
import Component from '@glimmer/component';
import { service } from '@ember/service';
import type FlashMessageService from 'ember-cli-flash/services/flash-messages';
import config from '@apps/front/config/environment';

interface ApplicationSignature {
  Args: {
    model: unknown;
    controller: unknown;
  };
}

class ApplicationTemplate extends Component<ApplicationSignature> {
  @service declare flashMessages: FlashMessageService;

  get buildVersion(): string | undefined {
    const version = config.APP['version'] as string | undefined;
    return version && version !== 'dev' ? version : undefined;
  }

  <template>
    {{pageTitle "Application"}}
    {{#if this.buildVersion}}
      <div
        title="Version du build"
        data-test-build-version
        class="pointer-events-none fixed right-2 bottom-1.5 rounded-md bg-neutral-900/60 px-[7px] py-0.5 font-mono text-[11px] leading-normal tracking-wide text-white opacity-60 select-none"
      >{{this.buildVersion}}</div>
    {{/if}}
    <div id="tpk-modal"></div>
    <div class="alerts">
      {{#each this.flashMessages.arrangedQueue as |flash|}}
        <FlashMessage @flash={{flash}} />
      {{/each}}
    </div>

    {{outlet}}
  </template>
}

export default ApplicationTemplate;
