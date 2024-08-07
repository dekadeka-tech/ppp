import ppp from '../../ppp.js';
import { html, css, ref } from '../../vendor/fast-element.min.js';
import { validate, invalidate, maybeFetchError } from '../../lib/ppp-errors.js';
import {
  Page,
  pageStyles,
  documentPageHeaderPartial,
  documentPageFooterPartial
} from '../page.js';
import { HMAC, sha256 } from '../../lib/ppp-crypto.js';
import {
  generateYCAWSSigningKey,
  generateYandexIAMToken
} from '../../lib/yc.js';
import { APIS } from '../../lib/const.js';
import * as jose from '../../vendor/jose.min.js';
import '../badge.js';
import '../button.js';
import '../snippet.js';
import '../text-field.js';

export const apiYcPageTemplate = html`
  <template class="${(x) => x.generateClasses()}">
    <ppp-loader></ppp-loader>
    <form novalidate>
      ${documentPageHeaderPartial({
        pageUrl: import.meta.url
      })}
      <section>
        <div class="label-group">
          <h5>Название подключения</h5>
          <p class="description">
            Произвольное имя, чтобы ссылаться на этот профиль, когда
            потребуется.
          </p>
        </div>
        <div class="input-group">
          <ppp-text-field
            placeholder="Yandex Cloud"
            value="${(x) => x.document.name}"
            ${ref('name')}
          ></ppp-text-field>
        </div>
      </section>
      <section>
        <div class="label-group">
          <h5>Сервисный аккаунт Yandex Cloud</h5>
          <p class="description">Идентификатор сервисного аккаунта.</p>
        </div>
        <div class="input-group">
          <ppp-text-field
            placeholder="Введите значение"
            value="${(x) => x.document.ycServiceAccountID}"
            ${ref('ycServiceAccountID')}
          ></ppp-text-field>
        </div>
      </section>
      <section>
        <div class="label-group">
          <h5>Идентификатор открытого ключа Yandex Cloud</h5>
          <p class="description">
            Идентификатор открытого авторизованного ключа сервисного аккаунта.
          </p>
        </div>
        <div class="input-group">
          <ppp-text-field
            placeholder="Введите значение"
            value="${(x) => x.document.ycPublicKeyID}"
            ${ref('ycPublicKeyID')}
          ></ppp-text-field>
        </div>
      </section>
      <section>
        <div class="label-group">
          <h5>Закрытый ключ Yandex Cloud</h5>
          <p class="description">
            Закрытый авторизованный ключ сервисного аккаунта.
          </p>
        </div>
        <div class="input-group">
          <ppp-snippet
            style="height: 256px"
            :code="${(x) =>
              x.document.ycPrivateKey ??
              `-----BEGIN PRIVATE KEY-----
-----END PRIVATE KEY-----`}"
            ${ref('ycPrivateKey')}
          ></ppp-snippet>
        </div>
      </section>
      <section>
        <div class="label-group">
          <h5>Идентификатор статического ключа</h5>
          <p class="description">Требуется для доступа к хранилищу объектов.</p>
        </div>
        <div class="input-group">
          <ppp-text-field
            placeholder="YC"
            value="${(x) => x.document.ycStaticKeyID}"
            ${ref('ycStaticKeyID')}
          ></ppp-text-field>
        </div>
      </section>
      <section>
        <div class="label-group">
          <h5>Секрет статического ключа</h5>
        </div>
        <div class="input-group">
          <ppp-text-field
            type="password"
            placeholder="YC"
            value="${(x) => x.document.ycStaticKeySecret}"
            ${ref('ycStaticKeySecret')}
          ></ppp-text-field>
        </div>
      </section>
      ${documentPageFooterPartial()}
    </form>
  </template>
`;

export const apiYcPageStyles = css`
  ${pageStyles}
`;

export class ApiYcPage extends Page {
  collection = 'apis';

  async validate() {
    await validate(this.name);
    await validate(this.ycServiceAccountID);
    await validate(this.ycPublicKeyID);
    await validate(this.ycPrivateKey);
    await validate(this.ycStaticKeyID);
    await validate(this.ycStaticKeySecret);

    let jwt;

    try {
      jwt = await generateYandexIAMToken({
        jose,
        ycServiceAccountID: this.ycServiceAccountID.value.trim(),
        ycPublicKeyID: this.ycPublicKeyID.value.trim(),
        ycPrivateKey: this.ycPrivateKey.value.trim()
      });
    } catch (e) {
      invalidate(this.ycPrivateKey, {
        errorMessage:
          'Не удалось сгенерировать JWT. Проверьте правильность ключей Yandex Cloud.',
        raiseException: true
      });
    }

    const iamTokenRequest = await ppp.fetch(
      'https://iam.api.cloud.yandex.net/iam/v1/tokens',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ jwt })
      }
    );

    await maybeFetchError(
      iamTokenRequest,
      'Не удалось получить IAM-токен. Проверьте правильность ключей Yandex Cloud.'
    );

    const host = 'storage.yandexcloud.net';
    const xAmzDate =
      new Date()
        .toISOString()
        .replaceAll('-', '')
        .replaceAll(':', '')
        .split('.')[0] + 'Z';
    const date = xAmzDate.split('T')[0];
    const signingKey = await generateYCAWSSigningKey({
      ycStaticKeySecret: this.ycStaticKeySecret.value.trim(),
      date
    });
    const canonicalRequest = `GET\n/\n\nhost:${host}\nx-amz-date:${xAmzDate}\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
    const scope = `${date}/ru-central1/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${xAmzDate}\n${scope}\n${await sha256(
      canonicalRequest
    )}`;
    const signature = await HMAC(signingKey, stringToSign, { format: 'hex' });
    const Authorization = `AWS4-HMAC-SHA256 Credential=${this.ycStaticKeyID.value.trim()}/${date}/ru-central1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`;

    await maybeFetchError(
      await ppp.fetch(`https://${host}/`, {
        headers: {
          Authorization,
          'X-Amz-Date': xAmzDate
        }
      }),
      'Не удалось выгрузить список бакетов. Проверьте статический ключ.'
    );
  }

  async read() {
    return (context) => {
      return context.services
        .get('mongodb-atlas')
        .db('ppp')
        .collection('[%#this.collection%]')
        .findOne({
          _id: new BSON.ObjectId('[%#payload.documentId%]'),
          type: `[%#(await import(ppp.rootUrl + '/lib/const.js')).APIS.YC%]`
        });
    };
  }

  async find() {
    return {
      type: APIS.YC,
      name: this.name.value.trim(),
      removed: { $ne: true }
    };
  }

  async submit() {
    return {
      $set: {
        name: this.name.value.trim(),
        ycServiceAccountID: this.ycServiceAccountID.value.trim(),
        ycPublicKeyID: this.ycPublicKeyID.value.trim(),
        ycPrivateKey: this.ycPrivateKey.value.trim(),
        ycStaticKeyID: this.ycStaticKeyID.value.trim(),
        ycStaticKeySecret: this.ycStaticKeySecret.value.trim(),
        version: 1,
        updatedAt: new Date()
      },
      $setOnInsert: {
        type: APIS.YC,
        createdAt: new Date()
      }
    };
  }
}

export default ApiYcPage.compose({
  template: apiYcPageTemplate,
  styles: apiYcPageStyles
}).define();
