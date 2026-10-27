import Component from '@glimmer/component';
import { service } from '@ember/service';
import type SessionService from 'ember-simple-auth/services/session';
import { clickable, create, fillable } from 'ember-cli-page-object';
import { createLoginValidationSchema } from './login-validation.ts';
import type z from 'zod';
import TpkLoginForm from '@triptyk/ember-ui/components/prefabs/tpk-login';
import type CurrentUserService from '#src/services/current-user.ts';
import { t } from 'ember-intl';
import type { IntlService } from 'ember-intl';
import AuthLayout from '../auth-layout.gts';
import { LinkTo } from '@ember/routing';
import type RouterService from '@ember/routing/router-service';
import type FlashMessageService from 'ember-cli-flash/services/flash-messages';
import {
  genericJsonApiErrorMessage,
  resolveJsonApiErrorMessage,
} from '@libs/shared-front/utils/json-api-error-message';

// Shape rejected by ember-simple-auth-token's Token#makeRequest: the
// authentication endpoint's response, not a WarpDrive AggregateError (login
// doesn't go through the store/Fetch handler) — see @lat reference below.
interface TokenAuthenticatorError {
  status?: number;
  json?: { errors?: { status?: string; code?: string; detail?: string }[] };
}

export default class LoginForm extends Component {
  @service declare session: SessionService;
  @service declare currentUser: CurrentUserService;
  @service declare intl: IntlService;
  @service declare router: RouterService;
  @service declare flashMessages: FlashMessageService;

  get loginValidationSchema(): ReturnType<typeof createLoginValidationSchema> {
    return createLoginValidationSchema(this.intl);
  }

  // @lat: [[frontend/shared-front#Login : erreur d'authentification non affichée]]
  onSubmit = async (
    data: z.infer<ReturnType<typeof createLoginValidationSchema>>
  ) => {
    try {
      await this.session.authenticate('authenticator:jwt', data);
    } catch (error) {
      const jsonApiError = (error as TokenAuthenticatorError | undefined)?.json
        ?.errors?.[0];
      this.flashMessages.danger(
        jsonApiError
          ? resolveJsonApiErrorMessage(jsonApiError, this.intl)
          : genericJsonApiErrorMessage(this.intl)
      );
    }
  };

  <template>
    <AuthLayout data-test-login-form>
      <h1>{{t "users.forms.login.title"}}</h1>
      <TpkLoginForm
        @onSubmit={{this.onSubmit}}
        @loginSchema={{this.loginValidationSchema}}
        class="tpk-login-form"
      />
      <LinkTo @route="forgot-password" class="forgot-password-link">
        Forgot password?
      </LinkTo>
    </AuthLayout>
  </template>
}

export const pageObject = create({
  scope: '[data-test-login-form]',
  email: fillable('[data-test-tpk-prefab-email-container="email"] input'),
  password: fillable(
    '[data-test-tpk-prefab-password-container="password"] input'
  ),
  submit: clickable('button[type="submit"]'),
});
