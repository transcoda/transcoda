import { BooleanField } from './BooleanField.tsx';
import { CodecListField } from './CodecListField.tsx';
import { EnumField } from './EnumField.tsx';
import { EnumListField } from './EnumListField.tsx';
import type { FieldProps } from './Field.tsx';
import { LanguageField } from './LanguageField.tsx';
import { LanguageListField } from './LanguageListField.tsx';
import { NumberField } from './NumberField.tsx';
import { RawJsonField } from './RawJsonField.tsx';
import { StringListField } from './StringListField.tsx';
import { TextField } from './TextField.tsx';

/** The control for a field's spec kind (the form generator's single entry point). */
export function SettingField(props: FieldProps) {
  switch (props.def.spec.kind) {
    case 'boolean':
      return <BooleanField {...props} />;
    case 'number':
      return <NumberField {...props} />;
    case 'enum':
      return <EnumField {...props} />;
    case 'url':
    case 'password':
    case 'text':
      return <TextField {...props} />;
    case 'language':
      return <LanguageField {...props} />;
    case 'languages':
      return <LanguageListField {...props} />;
    case 'enum-list':
      return <EnumListField {...props} />;
    case 'string-list':
      return <StringListField {...props} />;
    case 'codec-list':
      return <CodecListField {...props} />;
    case 'path-mappings':
    // Only plugin settings carry this marker; the node inspector never sees it.
    case 'raw':
      return <RawJsonField {...props} />;
  }
}
